import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { getMvpConfig } from '../../services/mvpConfig.service';
import { calcMvpScore } from '../../services/rating.service';

const router = Router();

// GET /api/dashboard — сводная статистика для главной страницы
router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const [empResult, pendingResult, top3Result, coinsResult, challengeResult] = await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM employees WHERE is_active = true`
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM store_exchanges WHERE status = 'pending'`
      ),
      // Берём метрики свежайшего месяца и считаем MVP «на лету», чтобы
      // дашборд обновлялся сразу после ввода метрик, без «Обработать месяц».
      pool.query<{
        id: number; name: string; storeName: string; year: number; month: number;
        mysteryShopperScore: string | null; reviewsCount: number;
        checklistPercent: string | null; revenuePercent: string | null;
      }>(
        `WITH latest AS (
           SELECT year, month FROM monthly_metrics
           WHERE mystery_shopper_score IS NOT NULL
              OR reviews_count > 0
              OR checklist_percent IS NOT NULL
              OR revenue_percent IS NOT NULL
           ORDER BY year DESC, month DESC
           LIMIT 1
         )
         SELECT e.id, e.name, s.name AS "storeName",
                mm.year, mm.month,
                mm.mystery_shopper_score::text AS "mysteryShopperScore",
                COALESCE(mm.reviews_count, 0) AS "reviewsCount",
                mm.checklist_percent::text     AS "checklistPercent",
                mm.revenue_percent::text       AS "revenuePercent"
         FROM monthly_metrics mm
         JOIN employees e ON e.id = mm.employee_id
         JOIN stores s ON s.id = e.store_id
         JOIN latest l ON l.year = mm.year AND l.month = mm.month
         WHERE e.is_active = true`
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM coin_transactions
         WHERE amount > 0
           AND EXTRACT(YEAR FROM created_at) = $1
           AND EXTRACT(MONTH FROM created_at) = $2`,
        [year, month]
      ),
      pool.query<{ id: number; name: string; season: string; year: number; endDate: string; completedCount: string }>(
        `SELECT sc.id, sc.name, sc.season, sc.year, sc.end_date::text AS "endDate",
                COUNT(sce.employee_id)::text AS "completedCount"
         FROM seasonal_challenges sc
         LEFT JOIN seasonal_challenge_entries sce ON sce.challenge_id = sc.id
         WHERE sc.end_date >= CURRENT_DATE AND sc.is_active = true
         GROUP BY sc.id, sc.name, sc.season, sc.year, sc.end_date
         ORDER BY sc.end_date ASC
         LIMIT 5`
      ),
    ]);

    const totalActiveEmps = parseInt(empResult.rows[0].count, 10);

    // Расчёт MVP «на лету» из текущих метрик (без необходимости «Обработать месяц»)
    const cfg = await getMvpConfig();
    const scored = top3Result.rows.map(r => {
      const score = calcMvpScore({
        mysteryShopperScore: r.mysteryShopperScore !== null ? parseFloat(r.mysteryShopperScore) : null,
        reviewsCount: Number(r.reviewsCount) || 0,
        checklistPercent: r.checklistPercent !== null ? parseFloat(r.checklistPercent) : null,
        revenuePercent: r.revenuePercent !== null ? parseFloat(r.revenuePercent) : null,
      }, cfg);
      return { id: r.id, name: r.name, storeName: r.storeName, mvpScore: score, year: r.year, month: r.month };
    });
    const top3Mvp = scored
      .filter(s => s.mvpScore > 0)
      .sort((a, b) => b.mvpScore - a.mvpScore)
      .slice(0, 3);

    const mvpPeriod = top3Mvp[0]
      ? { year: top3Mvp[0].year, month: top3Mvp[0].month }
      : null;

    res.json({
      activeEmployees: totalActiveEmps,
      pendingExchanges: parseInt(pendingResult.rows[0].count, 10),
      top3Mvp: top3Mvp.map(({ year: _y, month: _m, ...rest }) => rest),
      mvpPeriod,
      coinsIssuedThisMonth: parseInt(coinsResult.rows[0].total, 10),
      activeChallenges: challengeResult.rows.map(c => ({
        id: c.id,
        name: c.name,
        season: c.season,
        year: c.year,
        endDate: c.endDate,
        completedCount: parseInt(c.completedCount, 10),
        completionPercent: totalActiveEmps > 0
          ? Math.round(parseInt(c.completedCount, 10) / totalActiveEmps * 100)
          : 0,
      })),
    });
  } catch (err) { next(err); }
});

export default router;
