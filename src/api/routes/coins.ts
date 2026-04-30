import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { earn, getHistory, getBalance } from '../../services/coin.service';
import { notifyCoinAward } from '../../bot/notifications/sender';
import { logAudit } from '../../services/audit.service';
import { requireRole } from '../middleware/adminAuth';
import type { CoinReason } from '../../types';

const router = Router();

// POST /api/coins/award — только superadmin или coin_admin
router.post('/award', requireRole('superadmin', 'coin_admin'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { employeeId, reason, amount, createdBy, note } = req.body as {
      employeeId: number; reason: Exclude<CoinReason, 'spend'>;
      amount?: number; createdBy?: number; note?: string;
    };
    if (!employeeId || !reason) {
      res.status(400).json({ error: 'employeeId и reason обязательны' }); return;
    }

    let actualAmount: number;
    let tx: { id?: number };

    // Manual может быть отрицательным (списание) — пишем напрямую
    if (reason === 'manual' && typeof amount === 'number' && amount < 0) {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO coin_transactions (employee_id, amount, reason, note, created_by)
         VALUES ($1, $2, 'manual', $3, $4)
         RETURNING id`,
        [employeeId, amount, note ?? null, createdBy ?? null]
      );
      tx = rows[0];
      actualAmount = amount;
      res.status(201).json(tx);
    } else {
      const created = await earn({ employeeId, reason, amount, createdBy, note });
      tx = created;
      actualAmount = created.amount;
      res.status(201).json(tx);
    }

    // Async: уведомление + аудит — не блокируем ответ, но ошибки логируем
    notifyCoinAward(employeeId, actualAmount, reason, note).catch(err =>
      console.error('[notify] coin_award failed:', err instanceof Error ? err.message : err));
    logAudit('coin_award', { employeeId, amount: actualAmount, reason, note: note ?? null }).catch(err =>
      console.error('[audit] coin_award failed:', err instanceof Error ? err.message : err));
  } catch (err) { next(err); }
});

// GET /api/coins/balance/:employeeId
router.get('/balance/:employeeId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const balance = await getBalance(parseInt(req.params.employeeId, 10));
    res.json({ balance });
  } catch (err) { next(err); }
});

// GET /api/coins/history/:employeeId
router.get('/history/:employeeId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = parseInt((req.query.limit as string) ?? '20', 10);
    const history = await getHistory(parseInt(req.params.employeeId, 10), limit);
    res.json(history);
  } catch (err) { next(err); }
});

export default router;
