import { pool } from '../db/pool';
import { calcCardAwards, awardCards, awardTeamBonus } from './card.service';
import type {
  EmployeeRanking,
  MonthlyMetrics,
  MonthlyMetricsInput,
  ProcessMonthResult,
  StoreRanking,
} from '../types';

// ─── Формулы (чистые функции) ────────────────────────────────────────────────

/**
 * Рейтинг сотрудника (MVP Score), максимум ~105 баллов.
 *
 * Тайный покупатель  30%  score/100*30
 * Именные отзывы     25%  min(count*5, 25)
 * Чек-лист           25%  percent/100*25
 * Выполнение плана   20%  min(percent/100*20, 25)
 */
export function calcMvpScore(m: {
  mysteryShopperScore: number | null;
  reviewsCount: number;
  checklistPercent: number | null;
  revenuePercent: number | null;
}): number {
  const mystery   = m.mysteryShopperScore !== null ? (m.mysteryShopperScore / 100) * 30 : 0;
  const reviews   = Math.min(m.reviewsCount * 5, 25);
  const checklist = m.checklistPercent !== null ? (m.checklistPercent / 100) * 25 : 0;
  const revenue   = m.revenuePercent !== null ? Math.min((m.revenuePercent / 100) * 20, 25) : 0;
  return Math.round((mystery + reviews + checklist + revenue) * 100) / 100;
}

/**
 * Рейтинг точки (Store Score), максимум 100 баллов.
 *
 * Средний тайный покупатель  30%  avg/100*30
 * Рейтинг на отзовиках       25%  rating/5*25  (0–5 звёзд)
 * Средний чек-лист           25%  avg/100*25
 * Выполнение плана выручки   20%  min(percent/100*20, 25)
 */
export function calcStoreScore(s: {
  avgMysteryShoper: number | null;
  avgRatingScore: number | null;
  avgChecklist: number | null;
  revenuePercent: number | null;
}): number {
  const mystery   = ((s.avgMysteryShoper ?? 0) / 100) * 30;
  const rating    = ((s.avgRatingScore ?? 0) / 5) * 25;
  const checklist = ((s.avgChecklist ?? 0) / 100) * 25;
  const revenue   = Math.min(((s.revenuePercent ?? 0) / 100) * 20, 25);
  return Math.round((mystery + rating + checklist + revenue) * 100) / 100;
}

// ─── Работа с метриками ───────────────────────────────────────────────────────

/** Сохраняет или обновляет метрики сотрудника за месяц */
export async function upsertMetrics(input: MonthlyMetricsInput): Promise<MonthlyMetrics> {
  const { rows } = await pool.query<MonthlyMetrics>(
    `INSERT INTO monthly_metrics
       (employee_id, store_id, year, month,
        mystery_shopper_score, reviews_count, checklist_percent, revenue_percent, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (employee_id, year, month) DO UPDATE SET
       mystery_shopper_score = EXCLUDED.mystery_shopper_score,
       reviews_count         = EXCLUDED.reviews_count,
       checklist_percent     = EXCLUDED.checklist_percent,
       revenue_percent       = EXCLUDED.revenue_percent,
       updated_at            = NOW()
     RETURNING *`,
    [
      input.employeeId,
      input.storeId,
      input.year,
      input.month,
      input.mysteryShopperScore ?? null,
      input.reviewsCount ?? 0,
      input.checklistPercent ?? null,
      input.revenuePercent ?? null,
    ]
  );
  return rows[0];
}

/** Метрики всех сотрудников точки за месяц */
async function getStoreMetrics(
  storeId: number,
  year: number,
  month: number
): Promise<(MonthlyMetrics & { employeeName: string })[]> {
  const { rows } = await pool.query<MonthlyMetrics & { employeeName: string }>(
    `SELECT mm.*, e.name AS "employeeName"
     FROM monthly_metrics mm
     JOIN employees e ON e.id = mm.employee_id
     WHERE mm.store_id = $1 AND mm.year = $2 AND mm.month = $3
       AND e.is_active = true`,
    [storeId, year, month]
  );
  return rows;
}

/**
 * Обрабатывает одну точку за месяц:
 * считает MVP Score, определяет MVP, начисляет карточки.
 */
export async function processMonthForStore(
  storeId: number,
  year: number,
  month: number
): Promise<ProcessMonthResult['employees']> {
  const metrics = await getStoreMetrics(storeId, year, month);
  if (metrics.length === 0) return [];

  const scored = metrics.map(m => ({
    ...m,
    computedScore: calcMvpScore(m),
  }));

  const maxScore = Math.max(...scored.map(s => s.computedScore));
  // При ничьей MVP — первый по алфавиту
  const mvp = scored
    .filter(s => s.computedScore === maxScore)
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'ru'))[0];

  const results: ProcessMonthResult['employees'] = [];

  for (const s of scored) {
    const isMvp = s.id === mvp.id;

    await pool.query(
      `UPDATE monthly_metrics SET mvp_score = $1, is_mvp = $2, updated_at = NOW() WHERE id = $3`,
      [s.computedScore, isMvp, s.id]
    );

    const metricsWithMvp: MonthlyMetrics = { ...s, isMvp };
    const awards = calcCardAwards(metricsWithMvp);
    const awarded = await awardCards(s.employeeId, year, month, awards);

    const log = awarded.map(c => ({ heroId: c.heroId, source: c.source, isMvp: c.isMvp }));
    await pool.query(
      `UPDATE monthly_metrics SET cards_awarded = $1::jsonb, processed_at = NOW() WHERE id = $2`,
      [JSON.stringify(log), s.id]
    );

    results.push({
      employeeId: s.employeeId,
      name: s.employeeName,
      mvpScore: s.computedScore,
      isMvp,
      cardsAwarded: awarded.length,
    });
  }

  return results;
}

/**
 * Обрабатывает все активные точки за месяц:
 * определяет Топ-точку и начисляет командный бонус её команде.
 *
 * storeRatingScores — вручную введённые данные по точкам
 * (рейтинг на отзовиках + % выполнения плана по выручке).
 */
export async function processMonthAllStores(
  year: number,
  month: number,
  storeRatingScores: Map<number, { avgRatingScore: number; revenuePercent: number }>
): Promise<ProcessMonthResult[]> {
  const { rows: stores } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM stores WHERE is_active = true ORDER BY id`
  );

  type Intermediate = {
    storeId: number;
    storeName: string;
    employees: ProcessMonthResult['employees'];
    storeScore: number;
  };

  const storeResults: Intermediate[] = [];

  for (const store of stores) {
    const employees = await processMonthForStore(store.id, year, month);
    const metrics   = await getStoreMetrics(store.id, year, month);
    const extra     = storeRatingScores.get(store.id);

    const avgMystery   = numAvg(metrics.map(m => m.mysteryShopperScore));
    const avgChecklist = numAvg(metrics.map(m => m.checklistPercent));

    const storeScore = calcStoreScore({
      avgMysteryShoper: avgMystery,
      avgRatingScore:   extra?.avgRatingScore ?? null,
      avgChecklist,
      revenuePercent:   extra?.revenuePercent ?? null,
    });

    await pool.query(
      `INSERT INTO store_monthly_stats
         (store_id, year, month, avg_mystery_shopper, avg_rating_score,
          avg_checklist, revenue_percent, total_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (store_id, year, month) DO UPDATE SET
         avg_mystery_shopper = EXCLUDED.avg_mystery_shopper,
         avg_rating_score    = EXCLUDED.avg_rating_score,
         avg_checklist       = EXCLUDED.avg_checklist,
         revenue_percent     = EXCLUDED.revenue_percent,
         total_score         = EXCLUDED.total_score`,
      [store.id, year, month, avgMystery, extra?.avgRatingScore ?? null,
       avgChecklist, extra?.revenuePercent ?? null, storeScore]
    );

    storeResults.push({ storeId: store.id, storeName: store.name, employees, storeScore });
  }

  // Ранжируем по score DESC
  storeResults.sort((a, b) => b.storeScore - a.storeScore);

  const finalResults: ProcessMonthResult[] = [];

  for (let i = 0; i < storeResults.length; i++) {
    const s    = storeResults[i];
    const rank = i + 1;
    const isTop = rank === 1;

    await pool.query(
      `UPDATE store_monthly_stats
       SET rank = $1, is_top = $2, processed_at = NOW()
       WHERE store_id = $3 AND year = $4 AND month = $5`,
      [rank, isTop, s.storeId, year, month]
    );

    if (isTop) await awardTeamBonus(s.storeId, year, month);

    finalResults.push({
      year,
      month,
      storeId: s.storeId,
      employees: s.employees,
      topStore: isTop,
      storeScore: s.storeScore,
      storeRank: rank,
    });
  }

  return finalResults;
}

// ─── Запросы рейтингов ───────────────────────────────────────────────────────

/** Рейтинг сотрудников одной точки за месяц */
export async function getEmployeeLeaderboard(
  storeId: number,
  year: number,
  month: number
): Promise<EmployeeRanking[]> {
  const { rows } = await pool.query<EmployeeRanking>(
    `SELECT
       mm.employee_id                                              AS "employeeId",
       e.name,
       mm.mvp_score                                               AS "mvpScore",
       mm.is_mvp                                                  AS "isMvp",
       COUNT(ec.id) FILTER (WHERE ec.is_spent = false)            AS "cardsCount",
       COALESCE((
         SELECT SUM(ct.amount) FROM coin_transactions ct
         WHERE ct.employee_id = mm.employee_id
       ), 0)                                                       AS "coinsBalance"
     FROM monthly_metrics mm
     JOIN employees e ON e.id = mm.employee_id
     LEFT JOIN employee_cards ec ON ec.employee_id = mm.employee_id
     WHERE mm.store_id = $1 AND mm.year = $2 AND mm.month = $3
       AND e.is_active = true
     GROUP BY mm.employee_id, e.name, mm.mvp_score, mm.is_mvp
     ORDER BY mm.mvp_score DESC NULLS LAST`,
    [storeId, year, month]
  );
  return rows;
}

/** Рейтинг всех точек за месяц */
export async function getStoreLeaderboard(
  year: number,
  month: number
): Promise<StoreRanking[]> {
  const { rows } = await pool.query<StoreRanking>(
    `SELECT
       sms.store_id   AS "storeId",
       s.name         AS "storeName",
       sms.total_score AS "totalScore",
       sms.rank,
       sms.is_top     AS "isTop"
     FROM store_monthly_stats sms
     JOIN stores s ON s.id = sms.store_id
     WHERE sms.year = $1 AND sms.month = $2
     ORDER BY sms.rank ASC NULLS LAST`,
    [year, month]
  );
  return rows;
}

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function numAvg(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}
