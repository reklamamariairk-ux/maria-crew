import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { getMvpConfig } from '../../services/mvpConfig.service';
import { calcMvpScore } from '../../services/rating.service';

const router = Router();

// GET /api/dashboard — сводная статистика для главной страницы
router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Иркутск (UTC+8) — чтобы счётчик «монет в этом месяце» не «прыгал» в полночь UTC
    const irkNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const year = irkNow.getUTCFullYear();
    const month = irkNow.getUTCMonth() + 1;

    const [empResult, pendingResult, top3Result, coinsResult, topPerformersResult] = await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM employees WHERE is_active = true`
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM store_exchanges WHERE status = 'pending'`
      ),
      // Метрики свежайшего месяца + сохранённый mvp_score (если был «Обработать месяц»).
      // Если ничего нет — всё равно показываем сотрудников с любыми проставленными полями.
      pool.query<{
        id: number; name: string; storeName: string; year: number; month: number;
        mysteryShopperScore: string | null; reviewsCount: number;
        checklistPercent: string | null; revenuePercent: string | null;
        savedMvpScore: string | null;
      }>(
        `WITH latest AS (
           SELECT year, month FROM monthly_metrics
           WHERE mystery_shopper_score IS NOT NULL
              OR COALESCE(reviews_count, 0) > 0
              OR checklist_percent IS NOT NULL
              OR revenue_percent IS NOT NULL
              OR mvp_score IS NOT NULL
           ORDER BY year DESC, month DESC
           LIMIT 1
         )
         SELECT e.id, e.name, s.name AS "storeName",
                mm.year, mm.month,
                mm.mystery_shopper_score::text AS "mysteryShopperScore",
                COALESCE(mm.reviews_count, 0) AS "reviewsCount",
                mm.checklist_percent::text     AS "checklistPercent",
                mm.revenue_percent::text       AS "revenuePercent",
                mm.mvp_score::text             AS "savedMvpScore"
         FROM monthly_metrics mm
         JOIN employees e ON e.id = mm.employee_id
         JOIN stores s ON s.id = e.store_id
         JOIN latest l ON l.year = mm.year AND l.month = mm.month
         WHERE e.is_active = true`
      ),
      // Месяц считаем по иркутскому времени — синхронно с getMonthlySummary
      // и месячными агрегациями на фронте Mini App. Без AT TIME ZONE EXTRACT
      // работает в UTC, и транзакция 1 числа в 02:00 Иркутска (18:00 UTC
      // прошлого дня) попадала бы в прошлый месяц.
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM coin_transactions
         WHERE amount > 0
           AND EXTRACT(YEAR  FROM created_at AT TIME ZONE 'Asia/Irkutsk') = $1
           AND EXTRACT(MONTH FROM created_at AT TIME ZONE 'Asia/Irkutsk') = $2`,
        [year, month]
      ),
      // Топ-10 по активности за текущий месяц (Иркутск). Считаем сумму
      // положительных транзакций по категориям: квиз, чек-лист, челленджи,
      // прочее. Списания и spend не учитываем — это не «выполненные задачи».
      pool.query<{
        id: number; name: string; storeName: string | null;
        totalCoins: string; quizCoins: string; checklistCoins: string;
        challengeCoins: string;
      }>(
        `SELECT e.id, e.name, s.name AS "storeName",
                SUM(CASE WHEN ct.amount > 0 THEN ct.amount ELSE 0 END)::text AS "totalCoins",
                SUM(CASE WHEN ct.reason = 'quiz'          AND ct.amount > 0 THEN ct.amount ELSE 0 END)::text AS "quizCoins",
                SUM(CASE WHEN ct.reason = 'checklist_day' AND ct.amount > 0 THEN ct.amount ELSE 0 END)::text AS "checklistCoins",
                SUM(CASE WHEN ct.reason = 'manual' AND ct.note LIKE 'Челлендж #%' AND ct.amount > 0 THEN ct.amount ELSE 0 END)::text AS "challengeCoins"
         FROM employees e
         JOIN coin_transactions ct ON ct.employee_id = e.id
         LEFT JOIN stores s ON s.id = e.store_id
         WHERE ct.amount > 0
           AND EXTRACT(YEAR  FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $1
           AND EXTRACT(MONTH FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $2
           AND e.is_active = true
         GROUP BY e.id, e.name, s.name
         HAVING SUM(CASE WHEN ct.amount > 0 THEN ct.amount ELSE 0 END) > 0
         ORDER BY SUM(CASE WHEN ct.amount > 0 THEN ct.amount ELSE 0 END) DESC
         LIMIT 10`,
        [year, month]
      ),
    ]);

    const totalActiveEmps = parseInt(empResult.rows[0].count, 10);

    // Расчёт MVP «на лету» — приоритет у сохранённого mvp_score,
    // если его нет — считаем из текущих метрик той же формулой.
    const cfg = await getMvpConfig();
    const scored = top3Result.rows.map(r => {
      const live = calcMvpScore({
        mysteryShopperScore: r.mysteryShopperScore !== null ? parseFloat(r.mysteryShopperScore) : null,
        reviewsCount: Number(r.reviewsCount) || 0,
        checklistPercent: r.checklistPercent !== null ? parseFloat(r.checklistPercent) : null,
        revenuePercent: r.revenuePercent !== null ? parseFloat(r.revenuePercent) : null,
      }, cfg);
      const saved = r.savedMvpScore !== null ? parseFloat(r.savedMvpScore) : null;
      const score = saved !== null && saved > 0 ? saved : live;
      return { id: r.id, name: r.name, storeName: r.storeName, mvpScore: score, year: r.year, month: r.month };
    });
    const top3Mvp = scored
      .sort((a, b) => b.mvpScore - a.mvpScore)
      .slice(0, 3);

    const mvpPeriod = top3Mvp[0]
      ? { year: top3Mvp[0].year, month: top3Mvp[0].month }
      : null;

    const topPerformers = topPerformersResult.rows.map(r => {
      const total      = parseInt(r.totalCoins, 10);
      const quiz       = parseInt(r.quizCoins, 10);
      const checklist  = parseInt(r.checklistCoins, 10);
      const challenge  = parseInt(r.challengeCoins, 10);
      const other      = total - quiz - checklist - challenge;
      return {
        id: r.id, name: r.name, storeName: r.storeName,
        totalCoins: total,
        byCategory: { quiz, checklist, challenge, other },
      };
    });

    res.json({
      activeEmployees: totalActiveEmps,
      pendingExchanges: parseInt(pendingResult.rows[0].count, 10),
      top3Mvp: top3Mvp.map(({ year: _y, month: _m, ...rest }) => rest),
      mvpPeriod,
      coinsIssuedThisMonth: parseInt(coinsResult.rows[0].total, 10),
      topPerformers,
    });
  } catch (err) { next(err); }
});

export default router;
