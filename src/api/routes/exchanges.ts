import { Router, Request, Response } from 'express';
import { pool } from '../../db/pool';
import { processExchange } from '../../services/exchange.service';
import type { ExchangeStatus } from '../../types';

const router = Router();

// GET /api/exchanges?status=pending&storeId= — список заявок
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const { status, storeId } = req.query as { status?: string; storeId?: string };

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (status) { params.push(status); conditions.push(`se.status = $${params.length}`); }
  if (storeId) { params.push(storeId); conditions.push(`e.store_id = $${params.length}`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT
       se.*,
       e.name AS "employeeName",
       s.name AS "storeName",
       p.name AS "prizeName",
       p.prize_type AS "prizeType"
     FROM store_exchanges se
     JOIN employees e ON e.id = se.employee_id
     JOIN stores s ON s.id = e.store_id
     JOIN prizes p ON p.id = se.prize_id
     ${where}
     ORDER BY se.created_at DESC
     LIMIT 100`,
    params
  );
  res.json(rows);
});

// PUT /api/exchanges/:id — подтвердить / отклонить / выдать
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const { status, processedBy, notes } = req.body as {
    status: ExchangeStatus;
    processedBy: number;
    notes?: string;
  };

  const allowed: ExchangeStatus[] = ['approved', 'rejected', 'fulfilled'];
  if (!allowed.includes(status)) {
    res.status(400).json({ error: `status должен быть: ${allowed.join(', ')}` }); return;
  }

  const exchange = await processExchange(
    parseInt(req.params.id, 10),
    status as 'approved' | 'rejected' | 'fulfilled',
    processedBy,
    notes
  );
  res.json(exchange);
});

export default router;
