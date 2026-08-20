import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { getMvpConfig } from '../../services/mvpConfig.service';
import { calcMvpScore } from '../../services/rating.service';
import { isOfficeStore, isOfficeWorkspace, isStoreInWorkspace } from '../../services/adminWorkspace.service';
import { getOneCSalesSummary } from '../../services/oneCSalesSummary.service';

const router = Router();

async function loadOfficeDashboard(req: Request, res: Response, year: number, month: number): Promise<void> {
  const storeId = req.query.storeId ? Number(req.query.storeId) : null;
  if (storeId !== null && (!Number.isInteger(storeId) || !await isOfficeStore(storeId))) {
    res.status(403).json({ error: 'Офисной роли недоступна эта команда' });
    return;
  }

  const storeClause = storeId ? 'AND COALESCE(oem.office_store_id, e.store_id) = $3' : '';
  const storeParams = storeId ? [year, month, storeId] : [year, month];
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const [employees, pending, coins, performers, oneCSales] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM employees e
         LEFT JOIN stores s ON s.id = e.store_id
         LEFT JOIN office_employee_memberships oem ON oem.employee_id = e.id
        WHERE e.is_active = true AND e.fired_at IS NULL
          AND (s.workspace = 'office' OR oem.employee_id IS NOT NULL)
          ${storeId ? 'AND COALESCE(oem.office_store_id, e.store_id) = $1' : ''}`,
      storeId ? [storeId] : [],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM store_exchanges se
         JOIN employees e ON e.id = se.employee_id
         LEFT JOIN office_employee_memberships oem ON oem.employee_id = e.id
        WHERE se.workspace = 'office' AND se.status IN ('pending', 'approved')
          ${storeId ? 'AND COALESCE(oem.office_store_id, e.store_id) = $1' : ''}`,
      storeId ? [storeId] : [],
    ),
    pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(ct.amount), 0)::text AS total
         FROM coin_transactions ct
         JOIN employees e ON e.id = ct.employee_id
         LEFT JOIN stores s ON s.id = e.store_id
         LEFT JOIN office_employee_memberships oem ON oem.employee_id = e.id
        WHERE ct.amount > 0 AND (s.workspace = 'office' OR oem.employee_id IS NOT NULL)
          AND EXTRACT(YEAR FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $1
          AND EXTRACT(MONTH FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $2
          ${storeClause}`,
      storeParams,
    ),
    pool.query<{
      id: number; name: string; storeName: string | null; totalCoins: string;
      quizCoins: string; checklistCoins: string; challengeCoins: string;
    }>(
      `SELECT e.id, e.name, COALESCE(os.name, s.name) AS "storeName",
              SUM(ct.amount)::text AS "totalCoins",
              SUM(CASE WHEN ct.reason = 'quiz' THEN ct.amount ELSE 0 END)::text AS "quizCoins",
              SUM(CASE WHEN ct.reason = 'checklist_day' THEN ct.amount ELSE 0 END)::text AS "checklistCoins",
              SUM(CASE WHEN ct.reason = 'manual' AND ct.note LIKE 'Челлендж #%' THEN ct.amount ELSE 0 END)::text AS "challengeCoins"
         FROM employees e
         LEFT JOIN stores s ON s.id = e.store_id
         LEFT JOIN office_employee_memberships oem ON oem.employee_id = e.id
         LEFT JOIN stores os ON os.id = oem.office_store_id
         JOIN coin_transactions ct ON ct.employee_id = e.id AND ct.amount > 0
        WHERE (s.workspace = 'office' OR oem.employee_id IS NOT NULL)
          AND e.is_active = true AND e.fired_at IS NULL
          AND EXTRACT(YEAR FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $1
          AND EXTRACT(MONTH FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $2
          ${storeClause}
        GROUP BY e.id, e.name, s.name, os.name
        ORDER BY SUM(ct.amount) DESC LIMIT 10`,
      storeParams,
    ),
    getOneCSalesSummary(period),
  ]);

  const topPerformers = performers.rows.map(row => {
    const total = Number(row.totalCoins);
    const quiz = Number(row.quizCoins);
    const checklist = Number(row.checklistCoins);
    const challenge = Number(row.challengeCoins);
    return {
      id: row.id, name: row.name, storeName: row.storeName, totalCoins: total,
      byCategory: { quiz, checklist, challenge, other: total - quiz - checklist - challenge },
    };
  });

  res.json({
    activeEmployees: Number(employees.rows[0]?.count ?? 0),
    pendingExchanges: Number(pending.rows[0]?.count ?? 0),
    actionRequiredExchanges: Number(pending.rows[0]?.count ?? 0),
    top3Mvp: [],
    mvpPeriod: null,
    coinsIssuedThisMonth: Number(coins.rows[0]?.total ?? 0),
    topPerformers,
    oneCSales,
    storeId,
  });
}

// GET /api/dashboard?storeId=N — сводная статистика для главной страницы.
// Параметр storeId фильтрует все блоки (активные сотрудники, заявки, монеты,
// топ-3 MVP, топ-10 исполнителей) — чтобы выбранная в сайдбаре точка
// синхронно влияла на дашборд.
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Иркутск (UTC+8) — чтобы счётчик «монет в этом месяце» не «прыгал» в полночь UTC
    const irkNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const year = irkNow.getUTCFullYear();
    const month = irkNow.getUTCMonth() + 1;

    if (isOfficeWorkspace(req)) {
      await loadOfficeDashboard(req, res, year, month);
      return;
    }

    const storeIdRaw = req.query.storeId;
    const storeId = storeIdRaw && !Array.isArray(storeIdRaw)
      ? parseInt(String(storeIdRaw), 10)
      : NaN;
    const hasStore = Number.isInteger(storeId) && storeId > 0;
    if (hasStore && !await isStoreInWorkspace(storeId, 'retail')) {
      res.status(403).json({ error: 'Эта точка недоступна в розничном контуре' });
      return;
    }

    const [empResult, pendingResult, top3Result, coinsResult, topPerformersResult] = await Promise.all([
      hasStore
        ? pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM employees WHERE is_active = true AND store_id = $1`,
            [storeId]
          )
        : pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM employees e
             JOIN stores s ON s.id = e.store_id
             WHERE e.is_active = true AND s.workspace = 'retail'`
          ),
      hasStore
        ? pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM store_exchanges se
             JOIN employees e ON e.id = se.employee_id
             WHERE se.status IN ('pending', 'approved') AND e.store_id = $1`,
            [storeId]
          )
        : pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM store_exchanges se
             JOIN employees e ON e.id = se.employee_id
             JOIN stores s ON s.id = e.store_id
             WHERE se.status IN ('pending', 'approved') AND s.workspace = 'retail'`
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
         WHERE e.is_active = true
           AND s.workspace = 'retail'
           ${hasStore ? `AND e.store_id = $1` : ''}`,
        hasStore ? [storeId] : []
      ),
      // Месяц считаем по иркутскому времени — синхронно с getMonthlySummary
      // и месячными агрегациями на фронте Mini App. Без AT TIME ZONE EXTRACT
      // работает в UTC, и транзакция 1 числа в 02:00 Иркутска (18:00 UTC
      // прошлого дня) попадала бы в прошлый месяц.
      hasStore
        ? pool.query<{ total: string }>(
            `SELECT COALESCE(SUM(ct.amount), 0)::text AS total
             FROM coin_transactions ct
             JOIN employees e ON e.id = ct.employee_id
             WHERE ct.amount > 0
               AND e.store_id = $3
               AND EXTRACT(YEAR  FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $1
               AND EXTRACT(MONTH FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $2`,
            [year, month, storeId]
          )
        : pool.query<{ total: string }>(
            `SELECT COALESCE(SUM(ct.amount), 0)::text AS total
             FROM coin_transactions ct
             JOIN employees e ON e.id = ct.employee_id
             JOIN stores s ON s.id = e.store_id
             WHERE ct.amount > 0 AND s.workspace = 'retail'
               AND EXTRACT(YEAR  FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $1
               AND EXTRACT(MONTH FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $2`,
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
           AND s.workspace = 'retail'
           ${hasStore ? `AND e.store_id = $3` : ''}
         GROUP BY e.id, e.name, s.name
         HAVING SUM(CASE WHEN ct.amount > 0 THEN ct.amount ELSE 0 END) > 0
         ORDER BY SUM(CASE WHEN ct.amount > 0 THEN ct.amount ELSE 0 END) DESC
         LIMIT 10`,
        hasStore ? [year, month, storeId] : [year, month]
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
      actionRequiredExchanges: parseInt(pendingResult.rows[0].count, 10),
      top3Mvp: top3Mvp.map(({ year: _y, month: _m, ...rest }) => rest),
      mvpPeriod,
      coinsIssuedThisMonth: parseInt(coinsResult.rows[0].total, 10),
      topPerformers,
      storeId: hasStore ? storeId : null,
    });
  } catch (err) { next(err); }
});

export default router;
