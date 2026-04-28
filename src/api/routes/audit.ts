import { Router, Request, Response, NextFunction } from 'express';
import { getAuditLog } from '../../services/audit.service';

const router = Router();

// GET /api/audit?page=1&pageSize=50
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const pageSize = Math.min(parseInt(String(req.query.pageSize ?? '50'), 10) || 50, 500);
    const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
    const offset = (page - 1) * pageSize;
    const result = await getAuditLog(pageSize, offset);
    res.json({ ...result, page, pages: Math.ceil(result.total / pageSize) });
  } catch (err) { next(err); }
});

export default router;
