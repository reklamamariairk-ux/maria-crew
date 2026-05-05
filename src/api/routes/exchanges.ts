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
    const { status, storeId, employeeId } = req.query as { status?: string; storeId?: string; employeeId?: string };
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (status)     { params.push(status);     conditions.push(`se.status = $${params.length}`); }
    if (storeId)    { params.push(storeId);    conditions.push(`e.store_id = $${params.length}`); }
    if (employeeId) { params.push(employeeId); conditions.push(`se.employee_id = $${params.length}`); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT se.id, se.employee_id AS "employeeId", se.prize_id AS "prizeId",
              se.cards_spent AS "cardsSpent", se.coins_spent AS "coinsSpent",
              se.card_ids AS "cardIds", se.status, se.notes,
              se.processed_by AS "processedBy", se.created_at AS "createdAt",
              se.processed_at AS "processedAt",
              e.name AS "employeeName", s.name AS "storeName",
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
    const { status, notes } = req.body as { status: ExchangeStatus; notes?: string };
    const allowed: ExchangeStatus[] = ['approved', 'rejected', 'fulfilled'];
    if (!allowed.includes(status)) {
      res.status(400).json({ error: `status должен быть: ${allowed.join(', ')}` }); return;
    }
    // processed_by берём из server-side — кто на самом деле обработал, не из body
    // (раньше body.processedBy игнорировался клиентом, теперь явно заполняем)
    const exchange = await processExchange(
      parseInt(req.params.id, 10),
      status as 'approved' | 'rejected' | 'fulfilled',
      req.adminUserId ?? null,
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
          notifyExchangeStatus(rows[0].employeeId, rows[0].prizeName, status, notes).catch(() => {});
        }
      }).catch(() => {});
      const action = status === 'fulfilled' ? 'exchange_fulfill' : 'exchange_reject';
      logAudit(action, { exchangeId: parseInt(req.params.id, 10), processedBy: req.adminUserId }).catch(() => {});
    }
  } catch (err) {
    // «Уже обработана» — клиентская ошибка, отдаём 409 (а не 500)
    if (err instanceof Error && /уже обработана/i.test(err.message)) {
      res.status(409).json({ error: err.message });
      return;
    }
    next(err);
  }
});

export default router;
