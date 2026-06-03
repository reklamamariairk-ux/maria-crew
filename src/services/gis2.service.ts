import path from 'path';
import fs from 'fs/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { pool } from '../db/pool';
import { calcStoreScore } from './rating.service';

const STATE_DIR = process.env.GIS2_STATE_DIR ?? '/data/gis2';
const STATE_PATH = path.join(STATE_DIR, 'state.json');

// Извлечение рейтинга из JSON-LD. Запускается в браузерном контексте через
// page.evaluate — `document` доступен там нативно. Объявлено как обычная
// функция в node-сборке (без lib:DOM в tsconfig), потому используем @ts-ignore.
const extractLdRating = (): number | null => {
  // @ts-ignore document есть только в браузерном контексте
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  for (const s of scripts) {
    try {
      // @ts-ignore браузерный контекст
      const json = JSON.parse(s.textContent || '{}');
      if (json?.aggregateRating?.ratingValue) return Number(json.aggregateRating.ratingValue);
    } catch { /* skip */ }
  }
  return null;
};

const GIS2_LOGIN_URL = 'https://account.2gis.com/';
const PUBLIC_CARD_URL = (city: string, firmId: string) =>
  `https://2gis.ru/${encodeURIComponent(city)}/firm/${encodeURIComponent(firmId)}`;

const DEFAULT_CITY = process.env.GIS2_CITY ?? 'irkutsk';

// ─── Низкоуровневые утилиты ─────────────────────────────────────────────────

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

async function stateExists(): Promise<boolean> {
  try { await fs.access(STATE_PATH); return true; } catch { return false; }
}

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'],
  });
}

async function createContext(browser: Browser): Promise<BrowserContext> {
  const exists = await stateExists();
  return browser.newContext({
    storageState: exists ? STATE_PATH : undefined,
    locale: 'ru-RU',
    viewport: { width: 1440, height: 1100 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
}

// ─── Логин (нужен один раз; потом storageState переиспользуется) ────────────

/**
 * Если есть сохранённый state — пробуем работать с ним.
 * Если нет или сессия протухла — выполняем email+pass логин и сохраняем state.
 * Возвращает true если сессия рабочая.
 */
export async function ensureGis2Session(): Promise<boolean> {
  await ensureStateDir();
  const email = process.env.GIS2_EMAIL;
  const pass = process.env.GIS2_PASS;

  const browser = await launchBrowser();
  try {
    const ctx = await createContext(browser);
    const page = await ctx.newPage();
    await page.goto(GIS2_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Если после goto нас редиректит на /login — state протух
    const onLogin = page.url().includes('login') || page.url().includes('signin');

    if (!onLogin) {
      // state ещё рабочий
      await ctx.storageState({ path: STATE_PATH });
      return true;
    }

    if (!email || !pass) {
      console.warn('[gis2] state протух, GIS2_EMAIL/GIS2_PASS не заданы — login невозможен');
      return false;
    }

    // Заполняем форму входа. Селекторы могут поменяться — обновлять при поломке.
    await page.fill('input[type="email"], input[name="login"], input[name="email"]', email);
    await page.fill('input[type="password"], input[name="password"]', pass);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    // Проверяем что после логина мы не на /login
    if (page.url().includes('login') || page.url().includes('signin')) {
      console.error('[gis2] login не удался — возможно 2FA, капча, или неверные креды');
      return false;
    }

    await ctx.storageState({ path: STATE_PATH });
    console.log('[gis2] storageState сохранён');
    return true;
  } finally {
    await browser.close();
  }
}

// ─── Парсинг рейтинга публичной карточки 2ГИС ───────────────────────────────

/**
 * Скрейпит ПУБЛИЧНУЮ страницу карточки точки на 2ГИС и парсит рейтинг.
 *
 * Логин не нужен — рейтинг виден всем. Карточка SPA: ждём появления
 * элемента с рейтингом, затем читаем число.
 *
 * gis2Id — это идентификатор организации в URL карточки 2ГИС
 * (например, https://2gis.ru/irkutsk/firm/70000001020449571 → 70000001020449571).
 */
export async function fetchGis2Rating(gis2Id: string, city = DEFAULT_CITY): Promise<number | null> {
  const browser = await launchBrowser();
  try {
    const ctx = await createContext(browser);
    // Картинки и шрифты не грузим — экономим трафик и время
    await ctx.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media') return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
    const url = PUBLIC_CARD_URL(city, gis2Id);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Сразу пытаемся найти рейтинг — 2ГИС рендерит его быстро.
    // Попытка 1: через aria-label «Оценка X.X из 5».
    const rating = await page
      .waitForSelector('[itemprop="ratingValue"], [aria-label*="Оценка"], [data-rating]', { timeout: 15000 })
      .then(async (el) => {
        if (!el) return null;
        // itemprop="ratingValue" — содержит число прямо в content
        const itempropContent = await el.getAttribute('content');
        if (itempropContent) {
          const n = parseFloat(itempropContent.replace(',', '.'));
          if (Number.isFinite(n)) return n;
        }
        // aria-label "Оценка 4.6 из 5"
        const aria = await el.getAttribute('aria-label');
        if (aria) {
          const m = aria.match(/(\d+[.,]\d+)/);
          if (m) {
            const n = parseFloat(m[1].replace(',', '.'));
            if (Number.isFinite(n)) return n;
          }
        }
        // Иногда — просто textContent
        const text = (await el.textContent())?.trim() ?? '';
        const m2 = text.match(/(\d+[.,]\d+)/);
        if (m2) {
          const n = parseFloat(m2[1].replace(',', '.'));
          if (Number.isFinite(n)) return n;
        }
        return null;
      })
      .catch(() => null);

    if (rating !== null) return rating;

    // Запасной путь — поиск JSON-LD скриптом
    const ld = await page.evaluate(extractLdRating);
    return ld ?? null;
  } finally {
    await browser.close();
  }
}

// ─── Поиск gis2_id по адресу точки ──────────────────────────────────────────

/**
 * Ищет карточку точки на 2ГИС по запросу «Мария {адрес}» и достаёт её id
 * из URL первой найденной карточки.
 * Возвращает gis2_id (только цифры) или null если не нашлось.
 */
export async function searchGis2IdByAddress(address: string, storeName?: string, city = DEFAULT_CITY): Promise<string | null> {
  const brand = storeName ? storeName : 'Мария';
  const query = `${brand} ${address}`.trim();
  const browser = await launchBrowser();
  try {
    const ctx = await createContext(browser);
    await ctx.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media') return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
    const url = `https://2gis.ru/${encodeURIComponent(city)}/search/${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Ждём появления любой ссылки на /firm/{id} в результатах поиска.
    const id = await page
      .waitForSelector('a[href*="/firm/"]', { timeout: 15000 })
      .then(async (el) => {
        if (!el) return null;
        const href = await el.getAttribute('href');
        if (!href) return null;
        const m = href.match(/\/firm\/(\d+)/);
        return m ? m[1] : null;
      })
      .catch(() => null);

    return id;
  } finally {
    await browser.close();
  }
}

export type DiscoverResult = {
  total: number;
  found: number;
  skippedHaveId: number;
  skippedNoAddress: number;
  failed: Array<{ storeId: number; storeName: string; reason: string }>;
  matches: Array<{ storeId: number; storeName: string; address: string; gis2Id: string }>;
};

/**
 * Проходит по всем активным точкам без gis2_id и пробует найти их карточку
 * на 2ГИС по адресу. Сразу записывает найденный id в stores.gis2_id.
 */
export async function discoverGis2IdsForAllStores(city = DEFAULT_CITY): Promise<DiscoverResult> {
  const result: DiscoverResult = {
    total: 0, found: 0, skippedHaveId: 0, skippedNoAddress: 0, failed: [], matches: [],
  };

  const { rows: stores } = await pool.query<{ id: number; name: string; address: string | null; gis2Id: string | null }>(
    `SELECT id, name, address, gis2_id AS "gis2Id" FROM stores WHERE is_active = true ORDER BY name`
  );
  result.total = stores.length;

  for (const s of stores) {
    if (s.gis2Id) { result.skippedHaveId += 1; continue; }
    if (!s.address) { result.skippedNoAddress += 1; continue; }
    try {
      const id = await searchGis2IdByAddress(s.address, undefined, city);
      if (!id) {
        result.failed.push({ storeId: s.id, storeName: s.name, reason: 'не нашёл карточку в выдаче 2ГИС' });
        continue;
      }
      await pool.query(`UPDATE stores SET gis2_id = $1 WHERE id = $2`, [id, s.id]);
      result.matches.push({ storeId: s.id, storeName: s.name, address: s.address, gis2Id: id });
      result.found += 1;
    } catch (e) {
      result.failed.push({
        storeId: s.id, storeName: s.name,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}

// ─── Массовое обновление по всем точкам ─────────────────────────────────────

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
 * Открываем один браузер и поочерёдно обновляем рейтинг каждой точки
 * (последовательно, чтобы не словить капчу 2ГИС от слишком частых запросов).
 */
export async function refreshAllGis2Ratings(year?: number, month?: number): Promise<Gis2RefreshResult> {
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;

  const result: Gis2RefreshResult = {
    ok: true, year: y, month: m, total: 0, updated: 0, skippedNoId: 0, failed: [],
  };

  const { rows: stores } = await pool.query<{ id: number; name: string; gis2Id: string | null }>(
    `SELECT id, name, gis2_id AS "gis2Id" FROM stores WHERE is_active = true ORDER BY name`
  );
  result.total = stores.length;

  const browser = await launchBrowser();
  try {
    const ctx = await createContext(browser);
    await ctx.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media') return route.abort();
      return route.continue();
    });

    for (const s of stores) {
      if (!s.gis2Id) { result.skippedNoId += 1; continue; }
      const page = await ctx.newPage();
      try {
        const url = PUBLIC_CARD_URL(DEFAULT_CITY, s.gis2Id);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        let rating: number | null = null;
        try {
          const el = await page.waitForSelector('[itemprop="ratingValue"], [aria-label*="Оценка"]', { timeout: 12000 });
          const content = await el.getAttribute('content');
          if (content) rating = parseFloat(content.replace(',', '.'));
          if (!Number.isFinite(rating ?? NaN)) {
            const aria = await el.getAttribute('aria-label');
            const match = aria?.match(/(\d+[.,]\d+)/);
            if (match) rating = parseFloat(match[1].replace(',', '.'));
          }
        } catch { /* пробуем JSON-LD */ }
        if (rating === null || !Number.isFinite(rating)) {
          rating = await page.evaluate(extractLdRating);
        }
        if (rating === null || !Number.isFinite(rating)) {
          result.failed.push({ storeId: s.id, storeName: s.name, reason: 'не нашёл rating на карточке' });
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
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  await recomputeAllStoreScores(y, m);

  return result;
}

async function recomputeAllStoreScores(year: number, month: number): Promise<void> {
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
