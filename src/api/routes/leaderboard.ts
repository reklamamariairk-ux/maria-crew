import { Router, Request, Response, NextFunction } from 'express';
import { getEmployeeLeaderboard, getStoreLeaderboard } from '../../services/rating.service';

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

export default router;
