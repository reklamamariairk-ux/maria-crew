import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { processExchange } from '../../services/exchange.service';
import { notifyExchangeStatus } from '../../bot/notifications/sender';
import { logAudit } from '../../services/audit.service';
import type { ExchangeStatus } from '../../types';

const router = Router();

// GET /api/exchanges?status=pending&storeId=
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { status, storeId } = req.query as { status?: string; storeId?: string };
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (status)  { params.push(status);  conditions.push(`se.status = $${params.length}`); }
    if (storeId) { params.push(storeId); conditions.push(`e.store_id = $${params.length}`); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT se.*, e.name AS "employeeName", s.name AS "storeName",
              p.name AS "prizeName", p.prize_type AS "prizeType"
       FROM store_exchanges se
       JOIN employees e ON e.id = se.employee_id
       JOIN stores s ON s.id = e.store_id
       JOIN prizes p ON p.id = se.prize_id
       ${where}
       ORDER BY se.created_at DESC LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// PUT /api/exchanges/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { status, processedBy, notes } = req.body as {
      status: ExchangeStatus; processedBy?: number | null; notes?: string;
    };
    const allowed: ExchangeStatus[] = ['approved', 'rejected', 'fulfilled'];
    if (!allowed.includes(status)) {
      res.status(400).json({ error: `status должен быть: ${allowed.join(', ')}` }); return;
    }
    const exchange = await processExchange(
      parseInt(req.params.id, 10),
      status as 'approved' | 'rejected' | 'fulfilled',
      processedBy ?? null,
      notes
    );
    res.json(exchange);

    // Получаем prize.name + employee.id для уведомления (после ответа клиенту)
    if (status === 'fulfilled' || status === 'rejected') {
      pool.query<{ employeeId: number; prizeName: string }>(
        `SELECT se.employee_id AS "employeeId", p.name AS "prizeName"
         FROM store_exchanges se JOIN prizes p ON p.id = se.prize_id
         WHERE se.id = $1`,
        [parseInt(req.params.id, 10)]
      ).then(({ rows }) => {
        if (rows[0]) {
          notifyExchangeStatus(rows[0].employeeId, rows[0].prizeName, status).catch(() => {});
        }
      }).catch(() => {});
      const action = status === 'fulfilled' ? 'exchange_fulfill' : 'exchange_reject';
      logAudit(action, { exchangeId: parseInt(req.params.id, 10) }).catch(() => {});
    }
  } catch (err) { next(err); }
});

export default router;
