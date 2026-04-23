import { Router, Request, Response } from 'express';
import { pool } from '../../db/pool';
import { upsertMetrics, processMonthAllStores, processMonthForStore } from '../../services/rating.service';
import { notifyMvp, notifyTopStore, publishMonthResults } from '../../bot/notifications/sender';
import type { MonthlyMetricsInput } from '../../types';

const router = Router();

// GET /api/metrics?storeId=&year=&month= — метрики точки за месяц
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const { storeId, year, month } = req.query as Record<string, string>;
  if (!storeId || !year || !month) {
    res.status(400).json({ error: 'storeId, year, month обязательны' }); return;
  }

  const { rows } = await pool.query(
    `SELECT mm.*, e.name AS "employeeName"
     FROM monthly_metrics mm
     JOIN employees e ON e.id = mm.employee_id
     WHERE mm.store_id = $1 AND mm.year = $2 AND mm.month = $3
       AND e.is_active = true
     ORDER BY e.name`,
    [storeId, year, month]
  );
  res.json(rows);
});

// POST /api/metrics/batch — сохранить метрики нескольких сотрудников сразу
router.post('/batch', async (req: Request, res: Response): Promise<void> => {
  const items = req.body as MonthlyMetricsInput[];
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Ожидается массив метрик' }); return;
  }

  const saved = await Promise.all(items.map(m => upsertMetrics(m)));
  res.json(saved);
});

// PUT /api/metrics/:id — обновить одну запись
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const {
    mysteryShopperScore,
    reviewsCount,
    checklistPercent,
    revenuePercent,
  } = req.body as Partial<MonthlyMetricsInput>;

  const { rows } = await pool.query(
    `UPDATE monthly_metrics SET
       mystery_shopper_score = COALESCE($1, mystery_shopper_score),
       reviews_count         = COALESCE($2, reviews_count),
       checklist_percent     = COALESCE($3, checklist_percent),
       revenue_percent       = COALESCE($4, revenue_percent),
       updated_at            = NOW()
     WHERE id = $5 RETURNING *`,
    [
      mysteryShopperScore ?? null,
      reviewsCount ?? null,
      checklistPercent ?? null,
      revenuePercent ?? null,
      req.params.id,
    ]
  );
  if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }
  res.json(rows[0]);
});

/**
 * POST /api/metrics/process
 * Тело: {
 *   year: number, month: number,
 *   storeRatings: [{ storeId, avgRatingScore, revenuePercent }]
 * }
 *
 * Запускает полный расчёт по всем точкам:
 * MVP → карточки → Топ-точка → уведомления → пост в канал
 */
router.post('/process', async (req: Request, res: Response): Promise<void> => {
  const { year, month, storeRatings } = req.body as {
    year: number;
    month: number;
    storeRatings: Array<{ storeId: number; avgRatingScore: number; revenuePercent: number }>;
  };

  if (!year || !month) { res.status(400).json({ error: 'year и month обязательны' }); return; }

  const scoresMap = new Map(
    (storeRatings ?? []).map(s => [
      s.storeId,
      { avgRatingScore: s.avgRatingScore, revenuePercent: s.revenuePercent },
    ])
  );

  const results = await processMonthAllStores(year, month, scoresMap);

  // Уведомления MVP и Топ-точка
  for (const result of results) {
    const { rows: storeRows } = await pool.query<{ name: string }>(
      `SELECT name FROM stores WHERE id = $1`, [result.storeId]
    );
    const storeName = storeRows[0]?.name ?? '';

    const mvp = result.employees.find(e => e.isMvp);
    if (mvp) {
      await notifyMvp(mvp.employeeId, storeName, month, year, mvp.mvpScore);
    }

    if (result.topStore) {
      await notifyTopStore(result.storeId, storeName, month, year, result.storeScore);
    }
  }

  // Пост в Telegram-канал
  await publishMonthResults(results, month, year);

  res.json({ ok: true, processed: results.length, results });
});

export default router;
