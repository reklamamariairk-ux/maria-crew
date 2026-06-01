// Локальный кэш Номенклатуры 1С УПП + поиск.
//
// Архитектура: maria-crew (Hostinger) НЕ в whitelist 1С → не может ходить
// напрямую. Refresh идёт через прокси sales-dashboard (Timeweb VDS,
// whitelisted): GET /api/upp/proxy/products-detail с X-API-Key.
// Результат upsert'ится в one_c_nomenclature_cache. Поиск — SQL ILIKE
// по локальному кэшу (быстро, без сетевых походов на каждый keystroke).
//
// Без env UPP_CATALOG_PROXY_URL — refresh возвращает {ok:false, reason}.
// Поиск всё равно работает по последнему успешному снимку.

import { pool } from '../db/pool';

const PROXY_URL = (process.env.UPP_CATALOG_PROXY_URL ?? '').trim();
const PROXY_KEY = (process.env.UPP_CATALOG_PROXY_KEY ?? '').trim();
const REFRESH_TIMEOUT_MS = 60_000; // каталог может быть большой

export interface CatalogItem {
  code: string;
  name: string;
  groupName: string | null;
  unit: string | null;
  unitRatio: number | null;
  weight: number | null;
  kind: string | null;
}

export interface CatalogStatus {
  rowCount: number;
  lastRefreshAt: string | null;
  lastRefreshCount: number | null;
  lastRefreshError: string | null;
  proxyConfigured: boolean;
}

export interface RefreshResult {
  ok: boolean;
  reason?: string;
  inserted?: number;
  updated?: number;
  total?: number;
}

export function isProxyConfigured(): boolean {
  return PROXY_URL.length > 0 && PROXY_KEY.length > 0;
}

export async function refreshCatalog(): Promise<RefreshResult> {
  if (!isProxyConfigured()) {
    const reason = 'UPP_CATALOG_PROXY_URL/KEY не заданы';
    await markRefresh(0, reason);
    return { ok: false, reason };
  }

  const ctrl = new AbortController();
  const tmr = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS);

  try {
    const res = await fetch(PROXY_URL, {
      method: 'GET',
      headers: { 'X-API-Key': PROXY_KEY },
      signal: ctrl.signal,
    });
    clearTimeout(tmr);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const reason = `proxy HTTP ${res.status}: ${text.slice(0, 200) || '(пусто)'}`;
      await markRefresh(0, reason);
      return { ok: false, reason };
    }

    const json = (await res.json()) as {
      rowsCount?: number;
      rows?: Array<{
        code?: string;
        name?: string;
        group?: string;
        unit?: string;
        unitRatio?: number | string;
        weight?: number | string;
        kind?: string;
      }>;
      error?: string;
    };
    if (json.error) {
      await markRefresh(0, `1С: ${json.error}`);
      return { ok: false, reason: json.error };
    }
    const rows = Array.isArray(json.rows) ? json.rows : [];

    // Upsert батчами по 500 строк, чтобы не упереться в bind-параметры.
    const BATCH = 500;
    const client = await pool.connect();
    let inserted = 0;
    let updated = 0;
    try {
      await client.query('BEGIN');
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH).filter(r => r && r.code && String(r.code).trim());
        if (!chunk.length) continue;
        // Строим VALUES (...), (...), (...) с параметрами.
        const placeholders: string[] = [];
        const values: (string | number | null)[] = [];
        chunk.forEach((r, idx) => {
          const offset = idx * 7;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
          );
          values.push(
            String(r.code).trim(),
            String(r.name ?? '').trim() || '(без названия)',
            r.group ? String(r.group).trim() : null,
            r.unit ? String(r.unit).trim() : null,
            r.unitRatio != null ? Number(r.unitRatio) : null,
            r.weight != null ? Number(r.weight) : null,
            r.kind ? String(r.kind).trim() : null
          );
        });
        const { rowCount } = await client.query(
          `INSERT INTO one_c_nomenclature_cache
             (code, name, group_name, unit, unit_ratio, weight, kind)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (code) DO UPDATE SET
             name = EXCLUDED.name,
             group_name = EXCLUDED.group_name,
             unit = EXCLUDED.unit,
             unit_ratio = EXCLUDED.unit_ratio,
             weight = EXCLUDED.weight,
             kind = EXCLUDED.kind,
             updated_at = now()`,
          values
        );
        // node-pg возвращает rowCount общий — на upsert не различает insert/update,
        // считаем по xmax = 0 отдельным запросом было бы дорого. Принимаем что
        // в логе для админа достаточно общего total.
        inserted += rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    await markRefresh(rows.length, null);
    return { ok: true, total: rows.length, inserted, updated };
  } catch (e) {
    clearTimeout(tmr);
    const reason = e instanceof Error ? e.message : String(e);
    await markRefresh(0, reason).catch(() => {});
    return { ok: false, reason };
  }
}

async function markRefresh(count: number, error: string | null): Promise<void> {
  await pool.query(
    `UPDATE one_c_catalog_meta
       SET last_refresh_at = now(),
           last_refresh_count = $1,
           last_refresh_error = $2
     WHERE id = 1`,
    [count, error]
  );
}

export async function searchCatalog(query: string, limit = 20): Promise<CatalogItem[]> {
  const q = (query ?? '').trim();
  const lim = Math.min(Math.max(limit, 1), 50);
  if (!q) return [];

  // Поиск по точному коду, потом по префиксу, потом по подстроке в имени.
  // Сортируем результаты так, чтобы лучшие матчи были сверху.
  // Фильтр: исключаем сырьё/полуфабрикаты/оборудование — для призов
  // нужны только готовые товары (Продукция / Комплект).
  const { rows } = await pool.query(
    `SELECT
        code,
        name,
        group_name AS "groupName",
        unit,
        unit_ratio AS "unitRatio",
        weight,
        kind,
        CASE
          WHEN lower(code) = lower($1) THEN 0
          WHEN lower(code) LIKE lower($1) || '%' THEN 1
          WHEN lower(name) ILIKE lower($1) || '%' THEN 2
          ELSE 3
        END AS rank
     FROM one_c_nomenclature_cache
     WHERE (code ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%')
       -- Блэклист только НЕпищевого хлама. Раньше исключали 'Полуфабрикат%' и
       -- 'Сырье%' — а в 1С ~290 реальных пирожков/тортов/эклеров помечены видом
       -- «Полуфабрикат (21)», и они пропадали из подбора призов. Теперь прячем
       -- только то, что точно нельзя подарить (инвентарь/тара/оргтехника/…),
       -- а всю готовую еду (Продукция, Комплект, Полуфабрикат, Товары для
       -- праздника, Кругляш, наборы) показываем.
       AND (kind IS NULL OR (
         kind NOT ILIKE 'Оргтехника%' AND
         kind NOT ILIKE 'Тара%' AND
         kind NOT ILIKE 'Хоз инвентарь%' AND
         kind NOT ILIKE 'Кухонный инвентарь%' AND
         kind NOT ILIKE 'Спецодежда%' AND
         kind NOT ILIKE 'Оборудование%' AND
         kind NOT ILIKE 'Запасные части%' AND
         kind NOT ILIKE 'Топливо%' AND
         kind NOT ILIKE 'Обслуживание%' AND
         kind NOT ILIKE 'Прочие материалы%' AND
         kind NOT ILIKE 'Сырье%' AND
         kind NOT ILIKE 'МБП%'
       ))
     ORDER BY rank, name
     LIMIT $2`,
    [q, lim]
  );
  return rows.map(r => ({
    code: r.code,
    name: r.name,
    groupName: r.groupName,
    unit: r.unit,
    unitRatio: r.unitRatio,
    weight: r.weight,
    kind: r.kind,
  }));
}

export async function getCatalogStatus(): Promise<CatalogStatus> {
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM one_c_nomenclature_cache`
  );
  const { rows: metaRows } = await pool.query(
    `SELECT last_refresh_at AS "lastRefreshAt",
            last_refresh_count AS "lastRefreshCount",
            last_refresh_error AS "lastRefreshError"
     FROM one_c_catalog_meta WHERE id = 1`
  );
  return {
    rowCount: countRows[0]?.n ?? 0,
    lastRefreshAt: metaRows[0]?.lastRefreshAt ?? null,
    lastRefreshCount: metaRows[0]?.lastRefreshCount ?? null,
    lastRefreshError: metaRows[0]?.lastRefreshError ?? null,
    proxyConfigured: isProxyConfigured(),
  };
}
