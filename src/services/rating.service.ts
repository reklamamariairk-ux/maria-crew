import { pool } from '../db/pool';
import { calcCardAwards, awardCards, awardTeamBonus } from './card.service';
import { getMvpConfig, type MvpConfig } from './mvpConfig.service';
import type {
  EmployeeRanking,
  MonthlyMetrics,
  MonthlyMetricsInput,
  ProcessMonthResult,
  StoreRanking,
} from '../types';

// ─── Формулы (чистые функции) ────────────────────────────────────────────────

/**
 * Линейный балл с порогом и штрафом.
 *   value ≥ threshold → +вес × (value − threshold) / (100 − threshold)  [max +вес при 100]
 *   value < threshold → −вес × (threshold − value) / threshold           [max −вес при 0]
 *   value == null или weight == 0 → 0 (нейтрально)
 *
 * Используется для тайного покупателя и чек-листа. Тайного можно временно
 * отключить через mystery_shopper_weight=0 (тогда штрафа тоже не будет).
 */
function thresholdScore(value: number | null, threshold: number, weight: number): number {
  if (value === null || weight === 0) return 0;
  if (value >= threshold) {
    const room = 100 - threshold;
    return room > 0 ? ((value - threshold) / room) * weight : weight;
  }
  return threshold > 0 ? -((threshold - value) / threshold) * weight : 0;
}

/**
 * Рейтинг сотрудника (MVP Score).
 * - Тайный покупатель: порог 80 (настраивается), выше — плюс до +вес, ниже — минус.
 * - Чек-лист: порог 70 (настраивается), выше — плюс до +вес, ниже — минус.
 * - Отзывы: +N за отзыв, потолок reviewsMax (минусов нет).
 * - План выручки: +(% / 100) × weightFactor, потолок revenueMax (минусов нет).
 *
 * Результат МОЖЕТ быть отрицательным (если штрафы перевесят плюсы).
 * Это автоматически режет шансы на MVP и карточки.
 */
export function calcMvpScore(
  m: {
    mysteryShopperScore: number | null;
    reviewsCount: number;
    checklistPercent: number | null;
    revenuePercent: number | null;
  },
  cfg?: Pick<
    MvpConfig,
    | 'mysteryShopperWeight' | 'mysteryShopperThreshold'
    | 'reviewsPerCard' | 'reviewsMax'
    | 'checklistWeight' | 'checklistThreshold'
    | 'revenueWeightFactor' | 'revenueMax'
  >
): number {
  const w = cfg ?? {
    mysteryShopperWeight: 0, mysteryShopperThreshold: 80,
    reviewsPerCard: 5, reviewsMax: 25,
    checklistWeight: 25, checklistThreshold: 70,
    revenueWeightFactor: 20, revenueMax: 25,
  };
  const mystery   = thresholdScore(m.mysteryShopperScore, w.mysteryShopperThreshold, w.mysteryShopperWeight);
  const reviews   = Math.min(m.reviewsCount * w.reviewsPerCard, w.reviewsMax);
  const checklist = thresholdScore(m.checklistPercent, w.checklistThreshold, w.checklistWeight);
  const revenue   = m.revenuePercent !== null ? Math.min((m.revenuePercent / 100) * w.revenueWeightFactor, w.revenueMax) : 0;
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

  const cfg = await getMvpConfig();
  const scored = metrics.map(m => ({
    ...m,
    computedScore: calcMvpScore(m, cfg),
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
    const awards = calcCardAwards(metricsWithMvp, cfg);
    const awarded = await awardCards(s.employeeId, year, month, awards, cfg.cardMaxReviewsCount);

    const log = awarded.map(c => ({ heroId: c.heroId, source: c.source, isMvp: c.isMvp }));
    await pool.query(
      `UPDATE monthly_metrics SET cards_awarded = $1::jsonb, processed_at = NOW() WHERE id = $2`,
      [JSON.stringify(log), s.id]
    );

    // Бонусные монеты MVP — настраивается админом в mvp_config
    if (isMvp && cfg.mvpCoinReward > 0) {
      const note = `MVP месяца: ${month}/${year}`;
      // Идемпотентно: проверяем, нет ли уже такого начисления за этот месяц
      const { rows: existing } = await pool.query<{ id: number }>(
        `SELECT id FROM coin_transactions
         WHERE employee_id = $1 AND reason = 'manual' AND note = $2`,
        [s.employeeId, note]
      );
      if (!existing[0]) {
        await pool.query(
          `INSERT INTO coin_transactions (employee_id, amount, reason, note)
           VALUES ($1, $2, 'manual', $3)`,
          [s.employeeId, cfg.mvpCoinReward, note]
        );
      }
    }

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

    // Если для точки не передана рейтинговая часть, читаем её из БД и сохраняем —
    // иначе одиночная обработка одной точки обнулила бы данные других.
    let avgRatingScoreVal: number | null = null;
    let revenuePercentVal: number | null = null;
    if (extra) {
      avgRatingScoreVal = extra.avgRatingScore;
      revenuePercentVal = extra.revenuePercent;
    } else {
      const { rows: existing } = await pool.query<{
        avgRatingScore: number | null; revenuePercent: number | null;
      }>(
        `SELECT avg_rating_score AS "avgRatingScore", revenue_percent AS "revenuePercent"
         FROM store_monthly_stats WHERE store_id = $1 AND year = $2 AND month = $3`,
        [store.id, year, month]
      );
      avgRatingScoreVal = existing[0]?.avgRatingScore ?? null;
      revenuePercentVal = existing[0]?.revenuePercent ?? null;
    }

    const avgMystery   = numAvg(metrics.map(m => m.mysteryShopperScore));
    const avgChecklist = numAvg(metrics.map(m => m.checklistPercent));

    const storeScore = calcStoreScore({
      avgMysteryShoper: avgMystery,
      avgRatingScore:   avgRatingScoreVal,
      avgChecklist,
      revenuePercent:   revenuePercentVal,
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
      [store.id, year, month, avgMystery, avgRatingScoreVal,
       avgChecklist, revenuePercentVal, storeScore]
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

    if (isTop) {
      await awardTeamBonus(s.storeId, year, month);
      // Бонусные монеты всей команде топ-точки
      const cfg = await getMvpConfig();
      if (cfg.topStoreCoinReward > 0) {
        const note = `Бонус топ-точки: ${month}/${year}`;
        const { rows: emps } = await pool.query<{ id: number }>(
          `SELECT id FROM employees WHERE store_id = $1 AND is_active = true`,
          [s.storeId]
        );
        for (const e of emps) {
          const { rows: existing } = await pool.query<{ id: number }>(
            `SELECT id FROM coin_transactions
             WHERE employee_id = $1 AND reason = 'manual' AND note = $2`,
            [e.id, note]
          );
          if (!existing[0]) {
            await pool.query(
              `INSERT INTO coin_transactions (employee_id, amount, reason, note)
               VALUES ($1, $2, 'manual', $3)`,
              [e.id, cfg.topStoreCoinReward, note]
            );
          }
        }
      }
    }

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

/** Рейтинг сотрудников за месяц. Если storeId не указан — все точки скопом.
 *  Показываем всех сотрудников — даже если по ним ещё нет записи в monthly_metrics.
 *  Это позволяет админу выставлять баллы вручную с нуля. Скрытые в конце. */
export async function getEmployeeLeaderboard(
  storeId: number | null,
  year: number,
  month: number
): Promise<EmployeeRanking[]> {
  const params: (number | null)[] = [year, month];
  let where = '';
  if (storeId !== null) {
    params.push(storeId);
    where = `WHERE e.store_id = $${params.length}`;
  }

  const { rows } = await pool.query<EmployeeRanking>(
    `SELECT
       e.id                                              AS "employeeId",
       e.name,
       e.store_id                                        AS "storeId",
       s.name                                            AS "storeName",
       e.is_active                                       AS "isActive",
       mm.mvp_score                                      AS "mvpScore",
       COALESCE(mm.is_mvp, false)                        AS "isMvp",
       (SELECT COUNT(*) FROM employee_cards ec
          WHERE ec.employee_id = e.id AND ec.is_spent = false) AS "cardsCount",
       COALESCE((SELECT SUM(amount) FROM coin_transactions ct
          WHERE ct.employee_id = e.id), 0)              AS "coinsBalance"
     FROM employees e
     LEFT JOIN stores s ON s.id = e.store_id
     LEFT JOIN monthly_metrics mm
       ON mm.employee_id = e.id AND mm.year = $1 AND mm.month = $2
     ${where}
     ORDER BY e.is_active DESC, mm.mvp_score DESC NULLS LAST, e.name`,
    params
  );
  return rows;
}

/** Рейтинг всех точек за месяц. Возвращает все активные точки,
 *  даже без записи в store_monthly_stats — админ сможет ввести балл вручную. */
export async function getStoreLeaderboard(
  year: number,
  month: number
): Promise<StoreRanking[]> {
  const { rows } = await pool.query<StoreRanking>(
    `SELECT
       s.id                            AS "storeId",
       s.name                          AS "storeName",
       sms.total_score                 AS "totalScore",
       sms.rank                        AS "rank",
       COALESCE(sms.is_top, false)     AS "isTop"
     FROM stores s
     LEFT JOIN store_monthly_stats sms
       ON sms.store_id = s.id AND sms.year = $1 AND sms.month = $2
     WHERE s.is_active = true
     ORDER BY sms.rank ASC NULLS LAST, s.name`,
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
