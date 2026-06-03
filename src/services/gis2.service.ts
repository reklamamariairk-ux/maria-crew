import { pool } from '../db/pool';
import { calcStoreScore } from './rating.service';

const GIS2_API = 'https://catalog.api.2gis.com/3.0/items/byid';

export async function fetchGis2Rating(gis2Id: string): Promise<number | null> {
  const key = process.env.GIS2_API_KEY;
  if (!key) return null;

  const url = `${GIS2_API}?id=${encodeURIComponent(gis2Id)}&fields=items.reviews&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;

  const data = await res.json() as { result?: { items?: Array<{ reviews?: { rating_value?: number } }> } };
  const rating = data?.result?.items?.[0]?.reviews?.rating_value;
  return typeof rating === 'number' ? rating : null;
}

export type Gis2RefreshResult = {
  ok: boolean;
  year: number;
  month: number;
  total: number;
  updated: number;
  skippedNoId: number;
  failed: Array<{ storeId: number; storeName: string; reason: string }>;
};

/**
 * Массово обновляет avg_rating_score в store_monthly_stats для всех активных
 * точек, у которых задан gis2_id. После обновления каждой точки пересчитывает
 * total_score (на основе avg_mystery_shopper/avg_checklist уже в БД +
 * новый rating + текущий revenue_percent), затем пересчитывает rank всех точек.
 *
 * Запускается:
 *  - cron'ом раз в день 06:00 Asia/Irkutsk;
 *  - вручную через POST /api/admin/refresh-gis2-ratings;
 *  - вручную через кнопку в UI Метрики «Обновить рейтинги 2ГИС».
 */
export async function refreshAllGis2Ratings(year?: number, month?: number): Promise<Gis2RefreshResult> {
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;

  const result: Gis2RefreshResult = {
    ok: true, year: y, month: m, total: 0, updated: 0, skippedNoId: 0, failed: [],
  };

  if (!process.env.GIS2_API_KEY) {
    result.ok = false;
    result.failed.push({ storeId: 0, storeName: 'env', reason: 'GIS2_API_KEY не задан' });
    return result;
  }

  const { rows: stores } = await pool.query<{ id: number; name: string; gis2Id: string | null }>(
    `SELECT id, name, gis2_id AS "gis2Id" FROM stores WHERE is_active = true ORDER BY name`
  );
  result.total = stores.length;

  // Параллелим запросы к 2ГИС с лимитом 4, чтобы не уйти в их rate-limit.
  const concurrency = 4;
  const queue = [...stores];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const s = queue.shift();
      if (!s) break;
      if (!s.gis2Id) { result.skippedNoId += 1; continue; }
      try {
        const rating = await fetchGis2Rating(s.gis2Id);
        if (rating === null) {
          result.failed.push({ storeId: s.id, storeName: s.name, reason: '2ГИС не вернул rating_value' });
          continue;
        }
        await pool.query(
          `INSERT INTO store_monthly_stats (store_id, year, month, avg_rating_score)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (store_id, year, month) DO UPDATE SET avg_rating_score = EXCLUDED.avg_rating_score`,
          [s.id, y, m, rating]
        );
        result.updated += 1;
      } catch (e) {
        result.failed.push({
          storeId: s.id, storeName: s.name,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });
  await Promise.all(workers);

  // Пересчёт total_score для всех обновлённых точек + rank всех.
  await recomputeAllStoreScores(y, m);

  return result;
}

async function recomputeAllStoreScores(year: number, month: number): Promise<void> {
  // Для каждой точки берём текущие avg_rating_score, revenue_percent из stats и
  // средние тайный/чек-лист по сотрудникам этого периода — пересчитываем total_score.
  const { rows: stats } = await pool.query<{
    storeId: number;
    avgRatingScore: string | null;
    revenuePercent: string | null;
  }>(
    `SELECT store_id AS "storeId", avg_rating_score AS "avgRatingScore", revenue_percent AS "revenuePercent"
     FROM store_monthly_stats WHERE year = $1 AND month = $2`,
    [year, month]
  );

  for (const st of stats) {
    const { rows: empRows } = await pool.query<{ mysteryShopperScore: string | null; checklistPercent: string | null }>(
      `SELECT mystery_shopper_score AS "mysteryShopperScore",
              checklist_percent     AS "checklistPercent"
       FROM monthly_metrics mm
       JOIN employees e ON e.id = mm.employee_id
       WHERE mm.store_id = $1 AND mm.year = $2 AND mm.month = $3 AND e.is_active = true`,
      [st.storeId, year, month]
    );
    const numAvg = (vals: (number | null)[]): number | null => {
      const v = vals.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const avgMystery = numAvg(empRows.map(r => r.mysteryShopperScore !== null ? parseFloat(r.mysteryShopperScore) : null));
    const avgChecklist = numAvg(empRows.map(r => r.checklistPercent !== null ? parseFloat(r.checklistPercent) : null));
    const total = calcStoreScore({
      avgMysteryShoper: avgMystery,
      avgRatingScore: st.avgRatingScore !== null ? parseFloat(st.avgRatingScore) : null,
      avgChecklist,
      revenuePercent: st.revenuePercent !== null ? parseFloat(st.revenuePercent) : null,
    });
    await pool.query(
      `UPDATE store_monthly_stats SET avg_mystery_shopper = $1, avg_checklist = $2, total_score = $3
       WHERE store_id = $4 AND year = $5 AND month = $6`,
      [avgMystery, avgChecklist, total, st.storeId, year, month]
    );
  }

  await pool.query(
    `WITH ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY total_score DESC NULLS LAST) AS rn
       FROM store_monthly_stats WHERE year = $1 AND month = $2
     )
     UPDATE store_monthly_stats sms SET rank = ranked.rn
     FROM ranked WHERE sms.id = ranked.id`,
    [year, month]
  );
}
