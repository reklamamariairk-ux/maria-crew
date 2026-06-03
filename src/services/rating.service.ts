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
 * «Практический» балл — сумма результатов сотрудника БЕЗ тайного покупателя:
 *   отзыв + чек-лист + выполнение плана.
 *
 * Этот балл используется для проверки порога MVP: лучшего сотрудника
 * назначаем только если его practical balls > mvpMinScore. По решению
 * пользователя — тайный покупатель не должен влиять на MVP-квалификацию,
 * потому что у разных сотрудников может вообще не быть оценки тайного.
 */
export function calcMvpQualifyingScore(
  m: { reviewsCount: number; checklistPercent: number | null; revenuePercent: number | null },
  cfg: Pick<MvpConfig,
    | 'reviewsPerCard' | 'reviewsMax'
    | 'checklistWeight' | 'checklistThreshold'
    | 'revenueWeightFactor' | 'revenueMax'>
): number {
  const reviews   = Math.min(m.reviewsCount * cfg.reviewsPerCard, cfg.reviewsMax);
  const checklist = thresholdScore(m.checklistPercent, cfg.checklistThreshold, cfg.checklistWeight);
  const revenue   = m.revenuePercent !== null ? Math.min((m.revenuePercent / 100) * cfg.revenueWeightFactor, cfg.revenueMax) : 0;
  return Math.round((reviews + checklist + revenue) * 100) / 100;
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
  // Безопасный приёмник: null/NaN/Infinity → 0. Иначе одно NaN в исходных
  // данных распространяется через арифметику и весь Store Score становится NaN.
  const safe = (v: number | null | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const mystery   = (safe(s.avgMysteryShoper) / 100) * 30;
  const rating    = (safe(s.avgRatingScore) / 5) * 25;
  const checklist = (safe(s.avgChecklist) / 100) * 25;
  const revenue   = Math.min((safe(s.revenuePercent) / 100) * 20, 25);
  return Math.round((mystery + rating + checklist + revenue) * 100) / 100;
}

// ─── Работа с метриками ───────────────────────────────────────────────────────

/** Сохраняет или обновляет метрики сотрудника за месяц */
export async function upsertMetrics(input: MonthlyMetricsInput): Promise<MonthlyMetrics> {
  const { rows } = await pool.query<MonthlyMetrics>(
    `INSERT INTO monthly_metrics
       (employee_id, store_id, year, month,
        mystery_shopper_score, reviews_count, checklist_percent, revenue_percent, attestation_percent, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (employee_id, year, month) DO UPDATE SET
       mystery_shopper_score = EXCLUDED.mystery_shopper_score,
       reviews_count         = EXCLUDED.reviews_count,
       checklist_percent     = EXCLUDED.checklist_percent,
       revenue_percent       = EXCLUDED.revenue_percent,
       attestation_percent   = EXCLUDED.attestation_percent,
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
      input.attestationPercent ?? null,
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
 * PREVIEW-пересчёт одной точки: считает mvp_score, выбирает MVP по новой логике
 * (порог + ничьи) и записывает в monthly_metrics.mvp_score/is_mvp.
 *
 * НЕ выдаёт карточки, НЕ начисляет монеты, НЕ шлёт уведомления. Это «как бы
 * предложение системы», которое админ потом смотрит в табе Рейтинг и при
 * необходимости корректирует руками. Финальные награды — отдельной функцией
 * commitRewardsForStore.
 */
export async function recomputeScoresForStore(
  storeId: number,
  year: number,
  month: number
): Promise<ProcessMonthResult['employees']> {
  const metrics = await getStoreMetrics(storeId, year, month);
  if (metrics.length === 0) return [];

  const cfg = await getMvpConfig();
  const scored = metrics.map(m => ({ ...m, computedScore: calcMvpScore(m, cfg) }));

  const maxScore = Math.max(...scored.map(s => s.computedScore));
  const tiedTop = scored.filter(s => s.computedScore === maxScore);
  const leader = tiedTop[0];
  const qualifying = leader ? calcMvpQualifyingScore(leader, cfg) : 0;
  const mvp = (tiedTop.length === 1 && qualifying > cfg.mvpMinScore) ? leader : null;

  const results: ProcessMonthResult['employees'] = [];
  for (const s of scored) {
    const isMvp = mvp !== null && s.id === mvp.id;
    await pool.query(
      `UPDATE monthly_metrics SET mvp_score = $1, is_mvp = $2, updated_at = NOW() WHERE id = $3`,
      [s.computedScore, isMvp, s.id]
    );
    results.push({
      employeeId: s.employeeId,
      name: s.employeeName,
      mvpScore: s.computedScore,
      isMvp,
      cardsAwarded: 0,
    });
  }
  return results;
}

/**
 * COMMIT-награды одной точке. Читает текущие значения is_mvp / mvp_score из БД
 * (могут быть уже отредактированы админом в табе Рейтинг руками) и на их
 * основе начисляет карточки, монеты MVP, монеты за отзывы. Идемпотентно.
 */
export async function commitRewardsForStore(
  storeId: number,
  year: number,
  month: number
): Promise<ProcessMonthResult['employees']> {
  const metrics = await getStoreMetrics(storeId, year, month);
  if (metrics.length === 0) return [];

  const cfg = await getMvpConfig();
  const results: ProcessMonthResult['employees'] = [];

  for (const s of metrics) {
    const isMvp = s.isMvp;
    const awards = calcCardAwards({ ...s, isMvp }, cfg);
    const awarded = await awardCards(s.employeeId, year, month, awards);
    const log = awarded.map(c => ({ heroId: c.heroId, source: c.source, isMvp: c.isMvp }));
    await pool.query(
      `UPDATE monthly_metrics SET cards_awarded = $1::jsonb, processed_at = NOW() WHERE id = $2`,
      [JSON.stringify(log), s.id]
    );

    if (isMvp && cfg.mvpCoinReward > 0) {
      const note = `MVP месяца: ${month}/${year}`;
      const { rows: existing } = await pool.query<{ id: number }>(
        `SELECT id FROM coin_transactions WHERE employee_id = $1 AND reason = 'manual' AND note = $2`,
        [s.employeeId, note]
      );
      if (!existing[0]) {
        await pool.query(
          `INSERT INTO coin_transactions (employee_id, amount, reason, note) VALUES ($1, $2, 'manual', $3)`,
          [s.employeeId, cfg.mvpCoinReward, note]
        );
      }
    }

    if (cfg.reviewCoinReward > 0 && s.reviewsCount > 0) {
      const reviewNote = `Отзывы: ${month}/${year}`;
      const { rows: existing } = await pool.query<{ id: number }>(
        `SELECT id FROM coin_transactions WHERE employee_id = $1 AND reason = 'review' AND note = $2`,
        [s.employeeId, reviewNote]
      );
      if (!existing[0]) {
        const amount = cfg.reviewCoinReward * s.reviewsCount;
        await pool.query(
          `INSERT INTO coin_transactions (employee_id, amount, reason, note) VALUES ($1, $2, 'review', $3)`,
          [s.employeeId, amount, reviewNote]
        );
      }
    }

    results.push({
      employeeId: s.employeeId,
      name: s.employeeName,
      mvpScore: Number(s.mvpScore ?? 0),
      isMvp,
      cardsAwarded: awarded.length,
    });
  }
  return results;
}

/**
 * Back-compat: старая function name. Вызов = preview + commit одним заходом.
 * Используется только cron autoProcessMonth и старыми кодом если есть.
 */
export async function processMonthForStore(
  storeId: number,
  year: number,
  month: number
): Promise<ProcessMonthResult['employees']> {
  await recomputeScoresForStore(storeId, year, month);
  return commitRewardsForStore(storeId, year, month);
}

/**
 * Обрабатывает все активные точки за месяц:
 * определяет Топ-точку и начисляет командный бонус её команде.
 *
 * storeRatingScores — вручную введённые данные по точкам
 * (рейтинг на отзовиках + % выполнения плана по выручке).
 */
/**
 * PREVIEW-пересчёт всех точек: для каждой точки пересчитывает mvp_score/is_mvp
 * сотрудников, total_score точки и общий rank. Без карточек/монет/уведомлений.
 *
 * Вызывается после сохранения метрик (POST /metrics/batch и /metrics/store-ratings),
 * чтобы админ сразу видел в Рейтинге как баллы «легли» по новой формуле.
 */
export async function recomputeMonthScores(
  year: number,
  month: number,
  storeRatingScores?: Map<number, { avgRatingScore: number; revenuePercent: number }>
): Promise<void> {
  const { rows: stores } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM stores WHERE is_active = true ORDER BY id`
  );
  type Item = { storeId: number; storeScore: number };
  const storeScores: Item[] = [];
  for (const store of stores) {
    await recomputeScoresForStore(store.id, year, month);
    const metrics = await getStoreMetrics(store.id, year, month);
    const extra = storeRatingScores?.get(store.id);
    let avgRatingScoreVal: number | null = null;
    let revenuePercentVal: number | null = null;
    if (extra) {
      avgRatingScoreVal = extra.avgRatingScore;
      revenuePercentVal = extra.revenuePercent;
    } else {
      const { rows: existing } = await pool.query<{ avgRatingScore: number | null; revenuePercent: number | null }>(
        `SELECT avg_rating_score AS "avgRatingScore", revenue_percent AS "revenuePercent"
         FROM store_monthly_stats WHERE store_id = $1 AND year = $2 AND month = $3`,
        [store.id, year, month]
      );
      avgRatingScoreVal = existing[0]?.avgRatingScore ?? null;
      revenuePercentVal = existing[0]?.revenuePercent ?? null;
    }
    const avgMystery = numAvg(metrics.map(m => m.mysteryShopperScore));
    const avgChecklist = numAvg(metrics.map(m => m.checklistPercent));
    const storeScore = calcStoreScore({
      avgMysteryShoper: avgMystery, avgRatingScore: avgRatingScoreVal,
      avgChecklist, revenuePercent: revenuePercentVal,
    });
    await pool.query(
      `INSERT INTO store_monthly_stats
         (store_id, year, month, avg_mystery_shopper, avg_rating_score, avg_checklist, revenue_percent, total_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (store_id, year, month) DO UPDATE SET
         avg_mystery_shopper = EXCLUDED.avg_mystery_shopper,
         avg_rating_score    = EXCLUDED.avg_rating_score,
         avg_checklist       = EXCLUDED.avg_checklist,
         revenue_percent     = EXCLUDED.revenue_percent,
         total_score         = EXCLUDED.total_score`,
      [store.id, year, month, avgMystery, avgRatingScoreVal, avgChecklist, revenuePercentVal, storeScore]
    );
    storeScores.push({ storeId: store.id, storeScore });
  }
  // Ранжируем + назначаем топ-точку (preview is_top тоже считается)
  storeScores.sort((a, b) => b.storeScore - a.storeScore);
  const cfg = await getMvpConfig();
  const topCandidate = storeScores[0];
  const tiedTop = storeScores.filter(s => s.storeScore === topCandidate?.storeScore);
  const topStoreId = (tiedTop.length === 1 && topCandidate.storeScore > cfg.topStoreMinScore)
    ? topCandidate.storeId : null;
  for (let i = 0; i < storeScores.length; i++) {
    const s = storeScores[i];
    await pool.query(
      `UPDATE store_monthly_stats SET rank = $1, is_top = $2 WHERE store_id = $3 AND year = $4 AND month = $5`,
      [i + 1, s.storeId === topStoreId, s.storeId, year, month]
    );
  }
}

/**
 * COMMIT-награды: на основе ТЕКУЩИХ значений is_mvp/is_top в БД (которые могли
 * быть отредактированы админом в табе Рейтинг) начисляет карточки, монеты,
 * топ-бонусы и шлёт уведомления. Не пересчитывает баллы. Идемпотентно.
 *
 * Это то, что делает кнопка «Обработать месяц» в табе Рейтинг.
 */
export async function commitMonthRewards(year: number, month: number): Promise<ProcessMonthResult[]> {
  const { rows: stores } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM stores WHERE is_active = true ORDER BY id`
  );
  const cfg = await getMvpConfig();
  const finalResults: ProcessMonthResult[] = [];
  for (const store of stores) {
    const employees = await commitRewardsForStore(store.id, year, month);
    const { rows: stat } = await pool.query<{ isTop: boolean; totalScore: string | null; rank: number | null }>(
      `SELECT is_top AS "isTop", total_score AS "totalScore", rank
       FROM store_monthly_stats WHERE store_id = $1 AND year = $2 AND month = $3`,
      [store.id, year, month]
    );
    const isTop = stat[0]?.isTop === true;
    const storeScore = stat[0]?.totalScore !== null && stat[0]?.totalScore !== undefined ? parseFloat(stat[0].totalScore) : 0;
    const storeRank = stat[0]?.rank ?? 0;
    if (isTop) {
      await awardTeamBonus(store.id, year, month);
      if (cfg.topStoreCoinReward > 0) {
        const note = `Бонус топ-точки: ${month}/${year}`;
        const { rows: emps } = await pool.query<{ id: number }>(
          `SELECT id FROM employees WHERE store_id = $1 AND is_active = true`,
          [store.id]
        );
        for (const e of emps) {
          const { rows: existing } = await pool.query<{ id: number }>(
            `SELECT id FROM coin_transactions WHERE employee_id = $1 AND reason = 'manual' AND note = $2`,
            [e.id, note]
          );
          if (!existing[0]) {
            await pool.query(
              `INSERT INTO coin_transactions (employee_id, amount, reason, note) VALUES ($1, $2, 'manual', $3)`,
              [e.id, cfg.topStoreCoinReward, note]
            );
          }
        }
      }
    }
    await pool.query(
      `UPDATE store_monthly_stats SET processed_at = NOW() WHERE store_id = $1 AND year = $2 AND month = $3`,
      [store.id, year, month]
    );
    finalResults.push({
      year, month, storeId: store.id,
      employees, topStore: isTop, storeScore, storeRank,
    });
  }
  return finalResults;
}

/**
 * Back-compat для cron autoProcessMonth: preview + commit одним вызовом.
 */
export async function processMonthAllStores(
  year: number,
  month: number,
  storeRatingScores: Map<number, { avgRatingScore: number; revenuePercent: number }>
): Promise<ProcessMonthResult[]> {
  await recomputeMonthScores(year, month, storeRatingScores);
  return commitMonthRewards(year, month);
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
  // Отсеваем не только null, но и NaN/Infinity — иначе средняя «заразится»
  // и попадёт в БД как NaN, после чего всё дерево расчётов ломается.
  const valid = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (valid.length === 0) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}
