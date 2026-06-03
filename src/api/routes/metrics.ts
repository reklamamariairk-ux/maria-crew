import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { upsertMetrics, processMonthAllStores, recomputeMonthScores, commitMonthRewards, calcStoreScore } from '../../services/rating.service';
import { notifyMvp, notifyTopStore, publishMonthResults } from '../../bot/notifications/sender';
import { logAudit } from '../../services/audit.service';
import type { MonthlyMetricsInput } from '../../types';

const router = Router();

// GET /api/metrics?storeId=&year=&month=
// storeId опциональный — без него отдаёт всех сотрудников всех точек за период.
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { storeId, year, month } = req.query as Record<string, string>;
    if (!year || !month) {
      res.status(400).json({ error: 'year, month обязательны' }); return;
    }
    const params: unknown[] = [year, month];
    let where = 'mm.year = $1 AND mm.month = $2';
    if (storeId) {
      params.push(storeId);
      where += ` AND mm.store_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT mm.*, e.name AS "employeeName", e.is_active AS "isActive",
              s.name AS "storeName"
       FROM monthly_metrics mm
       JOIN employees e ON e.id = mm.employee_id
       LEFT JOIN stores s ON s.id = mm.store_id
       WHERE ${where}
       ORDER BY e.is_active DESC, s.name, e.name`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/metrics/store-ratings?year=&month=
// Возвращает по всем активным точкам avgRatingScore и revenuePercent (для редактирования
// в режиме «Все точки» в Метриках). Точки без записи отдаются с null-значениями.
router.get('/store-ratings', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { year, month } = req.query as Record<string, string>;
    if (!year || !month) {
      res.status(400).json({ error: 'year, month обязательны' }); return;
    }
    const { rows } = await pool.query(
      `SELECT s.id AS "storeId", s.name AS "storeName",
              sms.avg_rating_score AS "avgRatingScore",
              sms.revenue_percent AS "revenuePercent",
              sms.total_score AS "totalScore",
              sms.rank AS "rank",
              COALESCE(sms.is_top, false) AS "isTop"
       FROM stores s
       LEFT JOIN store_monthly_stats sms
         ON sms.store_id = s.id AND sms.year = $1 AND sms.month = $2
       WHERE s.is_active = true
       ORDER BY s.name`,
      [year, month]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/metrics/store-ratings
// Body: { year, month, items: [{ storeId, avgRatingScore, revenuePercent }] }
// Сохраняет ТОЛЬКО метрики точки (без процессинга MVP/карточек) — для подготовки
// данных перед «Обработать месяц».
router.post('/store-ratings', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { year, month, items } = req.body as {
      year: number; month: number;
      items: Array<{ storeId: number; avgRatingScore: number | null; revenuePercent: number | null }>;
    };
    if (!year || !month || !Array.isArray(items)) {
      res.status(400).json({ error: 'year, month, items обязательны' }); return;
    }
    for (const it of items) {
      await pool.query(
        `INSERT INTO store_monthly_stats
            (store_id, year, month, avg_rating_score, revenue_percent)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (store_id, year, month) DO UPDATE SET
            avg_rating_score = EXCLUDED.avg_rating_score,
            revenue_percent  = EXCLUDED.revenue_percent`,
        [it.storeId, year, month, it.avgRatingScore ?? null, it.revenuePercent ?? null]
      );
    }
    // Полный preview-пересчёт (mvp_score сотрудников + total_score точек + rank).
    // Без начисления карточек/монет/уведомлений — это делает «Обработать месяц».
    await recomputeMonthScores(year, month);
    res.json({ ok: true, saved: items.length });
    logAudit('store_ratings_save', { year, month, count: items.length }).catch(() => {});
  } catch (err) { next(err); }
});

// POST /api/metrics/batch
// После сохранения метрик автоматически делаем PREVIEW-пересчёт
// (mvp_score / is_mvp / total_score / rank). Финальные награды
// начисляются отдельной кнопкой «Обработать месяц» в Рейтинге.
router.post('/batch', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const items = req.body as MonthlyMetricsInput[];
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Ожидается массив метрик' }); return;
    }
    const saved = await Promise.all(items.map(m => upsertMetrics(m)));

    const year = items[0]?.year;
    const month = items[0]?.month;
    if (year && month) {
      try { await recomputeMonthScores(year, month); }
      catch (e) { console.error('[metrics/batch] preview recompute failed:', e); }
    }

    res.json(saved);
    logAudit('metrics_save', { count: saved.length, year, month, storeId: items[0]?.storeId }).catch(() => {});
  } catch (err) { next(err); }
});

// PUT /api/metrics/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { mysteryShopperScore, reviewsCount, checklistPercent, revenuePercent, attestationPercent } =
      req.body as Partial<MonthlyMetricsInput>;
    const { rows } = await pool.query(
      `UPDATE monthly_metrics SET
         mystery_shopper_score = COALESCE($1, mystery_shopper_score),
         reviews_count         = COALESCE($2, reviews_count),
         checklist_percent     = COALESCE($3, checklist_percent),
         revenue_percent       = COALESCE($4, revenue_percent),
         attestation_percent   = COALESCE($5, attestation_percent),
         updated_at            = NOW()
       WHERE id = $6 RETURNING *`,
      [mysteryShopperScore ?? null, reviewsCount ?? null,
       checklistPercent ?? null, revenuePercent ?? null, attestationPercent ?? null, req.params.id]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/**
 * POST /api/metrics/process
 * Body: { year, month, storeRatings: [{ storeId, avgRatingScore, revenuePercent }] }
 *
 * Обрабатывает все активные точки: MVP → карточки → Топ-точка → уведомления → канал.
 */
router.post('/process', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { year, month, storeRatings } = req.body as {
      year: number;
      month: number;
      storeRatings?: Array<{ storeId: number; avgRatingScore: number; revenuePercent: number }>;
    };
    if (!year || !month) { res.status(400).json({ error: 'year и month обязательны' }); return; }
    // Здравомыслящие границы — отсекают опечатки в UI (2030 на 3030 и т.п.)
    if (year < 2024 || year > 2100 || month < 1 || month > 12) {
      res.status(400).json({ error: 'Некорректные year/month' });
      return;
    }

    // НОВАЯ ЛОГИКА: «Обработать месяц» в Рейтинге = только начисление наград
    // на основе ТЕКУЩИХ значений is_mvp/is_top в БД (которые могли быть
    // отредактированы админом руками). Не пересчитываем mvp_score —
    // если нужно пересчитать, админ сначала жмёт «Сохранить» в Метриках.
    // storeRatings игнорируется здесь — он применяется только при сохранении
    // метрик точек через /metrics/store-ratings.
    void storeRatings; // для будущего back-compat
    const results = await commitMonthRewards(year, month);

    // Отвечаем сразу — данные уже сохранены. Уведомления улетают в фоне:
    // запросы к Telegram могут занять секунды × 16 точек × N сотрудников;
    // не должны блокировать UI админа.
    res.json({ ok: true, processed: results.length, results });
    logAudit('metrics_process', { year, month, storeIds: results.map(r => r.storeId) }).catch(() => {});

    // Background fan-out уведомлений — все параллельно, ошибки изолированы.
    const storeIds = results.map(r => r.storeId);
    const { rows: storeRows } = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM stores WHERE id = ANY($1)`, [storeIds]
    );
    const storeNames = new Map(storeRows.map(s => [s.id, s.name]));

    const notifications: Promise<unknown>[] = [];
    for (const result of results) {
      const storeName = storeNames.get(result.storeId) ?? '';
      const mvp = result.employees.find(e => e.isMvp);
      if (mvp) notifications.push(notifyMvp(mvp.employeeId, storeName, month, year, mvp.mvpScore));
      if (result.topStore) notifications.push(notifyTopStore(result.storeId, storeName, month, year, result.storeScore));
    }
    notifications.push(publishMonthResults(results, month, year));

    Promise.allSettled(notifications).then(rs => {
      const failed = rs.filter(r => r.status === 'rejected').length;
      if (failed > 0) console.warn(`[metrics/process] ${failed} уведомлений не доставлено`);
    });
  } catch (err) { next(err); }
});

export default router;
