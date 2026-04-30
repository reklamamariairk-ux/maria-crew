import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { getEmployeeLeaderboard, getStoreLeaderboard } from '../../services/rating.service';
import { logAudit } from '../../services/audit.service';

const router = Router();

// GET /api/leaderboard/employees?storeId=&year=&month=
router.get('/employees', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { storeId, year, month } = req.query as Record<string, string>;
    if (!storeId || !year || !month) {
      res.status(400).json({ error: 'storeId, year, month обязательны' }); return;
    }
    const data = await getEmployeeLeaderboard(
      parseInt(storeId, 10), parseInt(year, 10), parseInt(month, 10)
    );
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/leaderboard/stores?year=&month=
router.get('/stores', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { year, month } = req.query as Record<string, string>;
    if (!year || !month) { res.status(400).json({ error: 'year и month обязательны' }); return; }
    const data = await getStoreLeaderboard(parseInt(year, 10), parseInt(month, 10));
    res.json(data);
  } catch (err) { next(err); }
});

// PUT /api/leaderboard/employees/:employeeId
// body: { year, month, mvpScore?, isMvp?, storeId }
router.put('/employees/:employeeId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const client = await pool.connect();
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    const { year, month, mvpScore, isMvp, storeId } = req.body as {
      year: number; month: number; storeId: number;
      mvpScore?: number | null; isMvp?: boolean;
    };
    if (!year || !month || !storeId) { res.status(400).json({ error: 'year, month, storeId обязательны' }); return; }

    // Атомарно: гарантия записи + (если нужно) сброс MVP у других + сохранение значений.
    // Без транзакции возможна гонка — два параллельных PUT с isMvp=true дают двух MVP.
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO monthly_metrics (employee_id, store_id, year, month, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (employee_id, year, month) DO NOTHING`,
      [employeeId, storeId, year, month]
    );

    if (isMvp === true) {
      await client.query(
        `UPDATE monthly_metrics SET is_mvp = false, updated_at = NOW()
         WHERE store_id = $1 AND year = $2 AND month = $3 AND employee_id <> $4`,
        [storeId, year, month, employeeId]
      );
    }

    const sets: string[] = [];
    const vals: (number | boolean | null)[] = [];
    if (mvpScore !== undefined) { vals.push(mvpScore); sets.push(`mvp_score = $${vals.length}`); }
    if (isMvp    !== undefined) { vals.push(isMvp);    sets.push(`is_mvp = $${vals.length}`); }

    if (sets.length > 0) {
      sets.push(`updated_at = NOW()`);
      vals.push(employeeId, year, month);
      await client.query(
        `UPDATE monthly_metrics SET ${sets.join(', ')}
         WHERE employee_id = $${vals.length - 2} AND year = $${vals.length - 1} AND month = $${vals.length}`,
        vals
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });

    if (mvpScore !== undefined) {
      logAudit('rating_score_set', { employeeId, year, month, mvpScore }).catch(err =>
        console.error('[audit] rating_score_set failed:', err instanceof Error ? err.message : err));
    }
    if (isMvp !== undefined) {
      logAudit('rating_mvp_set', { employeeId, year, month, isMvp }).catch(err =>
        console.error('[audit] rating_mvp_set failed:', err instanceof Error ? err.message : err));
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/leaderboard/stores/:storeId
// body: { year, month, totalScore?, isTop? }
router.put('/stores/:storeId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const client = await pool.connect();
  try {
    const storeId = parseInt(req.params.storeId, 10);
    const { year, month, totalScore, isTop } = req.body as {
      year: number; month: number; totalScore?: number | null; isTop?: boolean;
    };
    if (!year || !month) { res.status(400).json({ error: 'year, month обязательны' }); return; }

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO store_monthly_stats (store_id, year, month)
       VALUES ($1, $2, $3)
       ON CONFLICT (store_id, year, month) DO NOTHING`,
      [storeId, year, month]
    );

    if (isTop === true) {
      await client.query(
        `UPDATE store_monthly_stats SET is_top = false
         WHERE year = $1 AND month = $2 AND store_id <> $3`,
        [year, month, storeId]
      );
    }

    const sets: string[] = [];
    const vals: (number | boolean | null)[] = [];
    if (totalScore !== undefined) { vals.push(totalScore); sets.push(`total_score = $${vals.length}`); }
    if (isTop      !== undefined) { vals.push(isTop);      sets.push(`is_top = $${vals.length}`); }
    if (sets.length > 0) {
      vals.push(storeId, year, month);
      await client.query(
        `UPDATE store_monthly_stats SET ${sets.join(', ')}
         WHERE store_id = $${vals.length - 2} AND year = $${vals.length - 1} AND month = $${vals.length}`,
        vals
      );
    }

    await client.query(
      `WITH ranked AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY total_score DESC NULLS LAST) AS rn
         FROM store_monthly_stats WHERE year = $1 AND month = $2
       )
       UPDATE store_monthly_stats sms SET rank = ranked.rn
       FROM ranked WHERE sms.id = ranked.id`,
      [year, month]
    );

    await client.query('COMMIT');
    res.json({ ok: true });

    if (totalScore !== undefined) {
      logAudit('rating_score_set', { storeId, year, month, totalScore }).catch(err =>
        console.error('[audit] rating_score_set failed:', err instanceof Error ? err.message : err));
    }
    if (isTop !== undefined) {
      logAudit('rating_top_set', { storeId, year, month, isTop }).catch(err =>
        console.error('[audit] rating_top_set failed:', err instanceof Error ? err.message : err));
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

export default router;
