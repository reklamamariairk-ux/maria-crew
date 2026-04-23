import { Router, Request, Response } from 'express';
import { earn, getHistory, getBalance } from '../../services/coin.service';
import type { CoinReason } from '../../types';

const router = Router();

// POST /api/coins/award — начислить монеты сотруднику вручную
router.post('/award', async (req: Request, res: Response): Promise<void> => {
  const { employeeId, reason, amount, createdBy, note } = req.body as {
    employeeId: number;
    reason: Exclude<CoinReason, 'spend'>;
    amount?: number;
    createdBy?: number;
    note?: string;
  };

  if (!employeeId || !reason) {
    res.status(400).json({ error: 'employeeId и reason обязательны' }); return;
  }

  const tx = await earn({ employeeId, reason, amount, createdBy, note });
  res.status(201).json(tx);
});

// GET /api/coins/balance/:employeeId
router.get('/balance/:employeeId', async (req: Request, res: Response): Promise<void> => {
  const balance = await getBalance(parseInt(req.params.employeeId, 10));
  res.json({ balance });
});

// GET /api/coins/history/:employeeId
router.get('/history/:employeeId', async (req: Request, res: Response): Promise<void> => {
  const limit = parseInt((req.query.limit as string) ?? '20', 10);
  const history = await getHistory(parseInt(req.params.employeeId, 10), limit);
  res.json(history);
});

export default router;
