import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';

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
      pool.query<{ id: number; name: string; storeName: string; mvpScore: string; year: number; month: number }>(
        `WITH latest AS (
           SELECT year, month FROM monthly_metrics
           WHERE mvp_score IS NOT NULL
           ORDER BY year DESC, month DESC
           LIMIT 1
         )
         SELECT e.id, e.name, s.name AS "storeName",
                ROUND(mm.mvp_score, 2)::text AS "mvpScore",
                mm.year, mm.month
         FROM monthly_metrics mm
         JOIN employees e ON e.id = mm.employee_id
         JOIN stores s ON s.id = e.store_id
         JOIN latest l ON l.year = mm.year AND l.month = mm.month
         WHERE mm.mvp_score IS NOT NULL
         ORDER BY mm.mvp_score DESC NULLS LAST
         LIMIT 3`
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

    const mvpPeriod = top3Result.rows[0]
      ? { year: top3Result.rows[0].year, month: top3Result.rows[0].month }
      : null;

    res.json({
      activeEmployees: totalActiveEmps,
      pendingExchanges: parseInt(pendingResult.rows[0].count, 10),
      top3Mvp: top3Result.rows.map(r => ({
        id: r.id, name: r.name, storeName: r.storeName,
        mvpScore: parseFloat(r.mvpScore),
      })),
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
