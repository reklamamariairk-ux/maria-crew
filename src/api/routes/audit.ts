import { Router, Request, Response, NextFunction } from 'express';
import { getAuditLog } from '../../services/audit.service';

const router = Router();

// GET /api/audit?limit=200
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const log = await getAuditLog(limit);
    res.json(log);
  } catch (err) { next(err); }
});

export default router;
