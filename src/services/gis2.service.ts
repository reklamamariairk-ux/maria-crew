import { pool } from '../db/pool';
import { calcStoreScore } from './rating.service';

// Прокси на sales-dashboard (Timeweb VDS, RU-IP). Без него 2ГИС редиректит
// нас на /museum («устаревший браузер») — защита на пограничных IP.
// UPP_CATALOG_PROXY_URL в env = .../api/upp/proxy/products-detail; нам нужна база.
const PROXY_URL = (process.env.UPP_CATALOG_PROXY_URL ?? '').replace(/\/api\/upp\/proxy\/.*$/, '');
const PROXY_KEY = process.env.UPP_CATALOG_PROXY_KEY ?? '';
// Города через запятую: у «Марии» есть точка в Ангарске, а карточки 2ГИС
// привязаны к городу — скрейпим филиалы по каждому и сливаем.
const CITIES = (process.env.GIS2_CITY ?? 'irkutsk,angarsk')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ORG_ID = process.env.GIS2_ORG_ID ?? '1548649242829424';

type ScrapedBranch = {
  id: string;
  rating: number | null;
  ratingCount: number | null;
  address: string | null;
  raw: string;
};

type BranchesProxyResp = {
  ok: boolean;
  ids?: number;
  cards?: number;
  branches?: ScrapedBranch[];
  error?: string;
};

type RatingProxyResp = { ok: boolean; rating?: number | null; error?: string };

async function callProxy<T>(path: string): Promise<T> {
  if (!PROXY_URL || !PROXY_KEY) {
    throw new Error('UPP_CATALOG_PROXY_URL / UPP_CATALOG_PROXY_KEY не заданы в env');
  }
  const url = `${PROXY_URL}${path}`;
  const res = await fetch(url, { headers: { 'X-API-Key': PROXY_KEY }, signal: AbortSignal.timeout(200000) });
  if (!res.ok) throw new Error(`proxy ${path} → ${res.status}`);
  return (await res.json()) as T;
}

// Скрейп филиалов организации по всем городам из CITIES, дедуп по id карточки.
async function scrapeBranchesAllCities(orgId: string): Promise<ScrapedBranch[]> {
  const out: ScrapedBranch[] = [];
  const seen = new Set<string>();
  for (const city of CITIES) {
    try {
      const r = await callProxy<BranchesProxyResp>(
        `/api/upp/proxy/gis2-branches?org=${encodeURIComponent(orgId)}&city=${encodeURIComponent(city)}`
      );
      if (!r.ok || !r.branches) {
        console.warn(`[gis2] branches(${city}) пусто: ${r.error ?? 'no branches'}`);
        continue;
      }
      for (const b of r.branches) {
        if (b.id && seen.has(b.id)) continue;
        if (b.id) seen.add(b.id);
        out.push(b);
      }
    } catch (e) {
      console.warn(`[gis2] branches(${city}) ошибка:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

// ─── Парсинг адреса для матчинга ────────────────────────────────────────────

function normalizeAddress(addr: string | null | undefined): string {
  if (!addr) return '';
  return addr
    .toLowerCase()
    .replace(/[ёе]/g, 'е')
    .replace(/(?:улица|ул\.?|проспект|пр-т|пр\.?|микрорайон|мкр\.?|бульвар|бул\.?|переулок|пер\.?|шоссе|ш\.?|площадь|пл\.?)/g, '')
    .replace(/\b(?:маршала|эдуарда|байкальская|свердлова|пушкина|жукова|баррикад|депутатская|ядринцева|лермонтова|ржанова|дьяконова|рабочая|сарафановская|декабрьских|событий|премьер|сезон|тц|бц|иркутск|ангарск|россия|область|иркутская)\b/gi, ' $& ')
    .replace(/[^\d\p{L}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addressTokens(addr: string | null | undefined): { tokens: Set<string>; numbers: string[] } {
  const n = normalizeAddress(addr);
  const all = n.split(/\s+/).filter(t => t.length >= 3);
  const tokens = new Set(all);
  const numbers = n.match(/\d+\S*/g) || [];
  return { tokens, numbers };
}

function addressSimilarity(a: string, b: string): number {
  const A = addressTokens(a);
  const B = addressTokens(b);
  if (!A.tokens.size || !B.tokens.size) return 0;
  // Совпадение хотя бы одного из чисел адреса критично — иначе матч случайный
  const numsCommon = A.numbers.filter(n => B.numbers.includes(n)).length;
  if (numsCommon === 0) return 0;
  let common = 0;
  for (const t of A.tokens) if (B.tokens.has(t)) common += 1;
  const denom = Math.max(A.tokens.size, B.tokens.size);
  return common / denom;
}

// ─── Публичные API ──────────────────────────────────────────────────────────

export type DiscoverResult = {
  total: number;
  found: number;
  scrapedBranches: number;
  failed: Array<{ storeId: number; storeName: string; reason: string }>;
  matches: Array<{ storeId: number; storeName: string; address: string; gis2Id: string; gis2Address: string | null; rating: number | null; similarity: number }>;
};

export async function discoverGis2IdsForAllStores(orgId = ORG_ID): Promise<DiscoverResult> {
  const result: DiscoverResult = { total: 0, found: 0, scrapedBranches: 0, failed: [], matches: [] };

  const branches = await scrapeBranchesAllCities(orgId);
  if (!branches.length) {
    result.failed.push({ storeId: 0, storeName: '_proxy', reason: 'no branches' });
    return result;
  }
  result.scrapedBranches = branches.length;

  const { rows: stores } = await pool.query<{ id: number; name: string; address: string | null; gis2Id: string | null }>(
    `SELECT id, name, address, gis2_id AS "gis2Id" FROM stores WHERE is_active = true ORDER BY name`
  );
  result.total = stores.length;

  // raw содержит и адрес и rating; парсим в parsedBranches и используем для матча
  type ParsedBranch = { id: string; address: string; rating: number | null };
  const parsedBranches: ParsedBranch[] = [];
  for (const b of branches) {
    // в raw на отдельных строках: "Кафе-кондитерская\nRATING\nN оценок\nADDRESS\nОткрыто"
    const lines = (b.raw || '').split('\n').map(s => s.trim()).filter(Boolean);
    const ratingLine = lines.find(l => /^[\d.,]+$/.test(l) && parseFloat(l.replace(',', '.')) >= 1 && parseFloat(l.replace(',', '.')) <= 5);
    const rating = ratingLine ? parseFloat(ratingLine.replace(',', '.')) : (b.rating ?? null);
    const addrLine = lines.find(l => /(ул|улица|проспект|пр-т|пр\.|мкр|микрорайон|бульвар|переулок|пер\.|шоссе|площадь)/i.test(l) && /\d/.test(l))
                   ?? lines.find(l => /\d+\S*/.test(l) && /иркутск|ангарск/i.test(l));
    if (b.id && addrLine) parsedBranches.push({ id: b.id, address: addrLine, rating });
  }

  // Матчинг каждой нашей точки с найденными карточками
  for (const s of stores) {
    if (s.gis2Id) continue;
    if (!s.address) { result.failed.push({ storeId: s.id, storeName: s.name, reason: 'нет адреса в БД' }); continue; }
    let best: ParsedBranch | null = null;
    let bestSim = 0;
    for (const b of parsedBranches) {
      const sim = addressSimilarity(s.address, b.address);
      if (sim > bestSim) { bestSim = sim; best = b; }
    }
    if (best && bestSim >= 0.25) {
      await pool.query(`UPDATE stores SET gis2_id = $1 WHERE id = $2`, [best.id, s.id]);
      result.matches.push({
        storeId: s.id, storeName: s.name, address: s.address, gis2Id: best.id,
        gis2Address: best.address, rating: best.rating, similarity: Math.round(bestSim * 100) / 100,
      });
      result.found += 1;
    } else {
      result.failed.push({ storeId: s.id, storeName: s.name, reason: `нет совпадения по адресу (best sim=${bestSim.toFixed(2)})` });
    }
  }

  return result;
}

// ─── Refresh ratings ────────────────────────────────────────────────────────

export type Gis2RefreshResult = {
  ok: boolean;
  year: number;
  month: number;
  total: number;
  updated: number;
  skippedNoId: number;
  failed: Array<{ storeId: number; storeName: string; reason: string }>;
};

export async function refreshAllGis2Ratings(year?: number, month?: number): Promise<Gis2RefreshResult> {
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;

  const result: Gis2RefreshResult = { ok: true, year: y, month: m, total: 0, updated: 0, skippedNoId: 0, failed: [] };

  if (!PROXY_URL || !PROXY_KEY) {
    result.ok = false;
    result.failed.push({ storeId: 0, storeName: '_proxy', reason: 'UPP_CATALOG_PROXY_URL / UPP_CATALOG_PROXY_KEY не заданы' });
    return result;
  }

  // Стратегия: тянем один большой /gis2-branches на город — там сразу и адреса и рейтинги.
  // Точечный /gis2-rating используем только если стора с gis2_id, которой нет в общем списке.
  const branches = await scrapeBranchesAllCities(ORG_ID);
  const byId = new Map<string, { rating: number | null }>();
  for (const b of branches) {
    const lines = (b.raw || '').split('\n').map(s => s.trim()).filter(Boolean);
    const ratingLine = lines.find(l => /^[\d.,]+$/.test(l) && parseFloat(l.replace(',', '.')) >= 1 && parseFloat(l.replace(',', '.')) <= 5);
    const rating = ratingLine ? parseFloat(ratingLine.replace(',', '.')) : (b.rating ?? null);
    if (b.id) byId.set(b.id, { rating });
  }

  const { rows: stores } = await pool.query<{ id: number; name: string; gis2Id: string | null }>(
    `SELECT id, name, gis2_id AS "gis2Id" FROM stores WHERE is_active = true ORDER BY name`
  );
  result.total = stores.length;

  for (const s of stores) {
    if (!s.gis2Id) { result.skippedNoId += 1; continue; }
    let rating = byId.get(s.gis2Id)?.rating ?? null;
    if (rating === null) rating = await fetchGis2Rating(s.gis2Id);
    if (rating === null) {
      result.failed.push({ storeId: s.id, storeName: s.name, reason: 'нет рейтинга от прокси' });
      continue;
    }
    await pool.query(
      `INSERT INTO store_monthly_stats (store_id, year, month, avg_rating_score)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (store_id, year, month) DO UPDATE SET avg_rating_score = EXCLUDED.avg_rating_score`,
      [s.id, y, m, rating]
    );
    result.updated += 1;
  }

  await recomputeAllStoreScores(y, m);
  return result;
}

async function recomputeAllStoreScores(year: number, month: number): Promise<void> {
  const { rows: stats } = await pool.query<{ storeId: number; avgRatingScore: string | null; revenuePercent: string | null }>(
    `SELECT store_id AS "storeId", avg_rating_score AS "avgRatingScore", revenue_percent AS "revenuePercent"
     FROM store_monthly_stats WHERE year = $1 AND month = $2`,
    [year, month]
  );
  for (const st of stats) {
    const { rows: empRows } = await pool.query<{ mysteryShopperScore: string | null; checklistPercent: string | null }>(
      `SELECT mystery_shopper_score AS "mysteryShopperScore", checklist_percent AS "checklistPercent"
       FROM monthly_metrics mm JOIN employees e ON e.id = mm.employee_id
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
     UPDATE store_monthly_stats sms SET rank = ranked.rn FROM ranked WHERE sms.id = ranked.id`,
    [year, month]
  );
}

// ─── Back-compat для cards.ts — UI кнопка «из 2ГИС» ─────────────────────────

/** Возвращает рейтинг одной карточки по её id. Используется кнопкой «из 2ГИС» в Метриках одной точки.
 *  Карточка живёт в одном городе — перебираем CITIES до первого ответа. */
export async function fetchGis2Rating(gis2Id: string): Promise<number | null> {
  for (const city of CITIES) {
    try {
      const r = await callProxy<RatingProxyResp>(`/api/upp/proxy/gis2-rating?id=${encodeURIComponent(gis2Id)}&city=${encodeURIComponent(city)}`);
      if (r.ok && typeof r.rating === 'number') return r.rating;
    } catch { /* пробуем следующий город */ }
  }
  return null;
}
