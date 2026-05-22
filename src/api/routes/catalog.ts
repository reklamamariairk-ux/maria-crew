import { Router, Request, Response, NextFunction } from 'express';
import { searchCatalog, refreshCatalog, getCatalogStatus } from '../../services/oneCCatalog.service';
import { logAudit } from '../../services/audit.service';

const router = Router();

// GET /api/catalog/search?q=кофе&limit=20
// Любой админ — нужен для подбора товара в форме «Призы».
router.get('/search', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const q = String(req.query.q ?? '').trim();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 50);
    if (!q) { res.json({ items: [] }); return; }
    const items = await searchCatalog(q, limit);
    res.json({ items });
  } catch (err) { next(err); }
});

// GET /api/catalog/status — для админки: показать когда обновлялось / сколько товаров.
router.get('/status', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const status = await getCatalogStatus();
    res.json(status);
  } catch (err) { next(err); }
});

// POST /api/catalog/refresh — ручной refresh из 1С через прокси.
// Может выполниться 30+ сек если каталог большой.
router.post('/refresh', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await refreshCatalog();
    if (result.ok) {
      logAudit('catalog_refresh', { total: result.total, by: req.adminUserId }).catch(() => {});
      res.json(result);
    } else {
      res.status(503).json(result);
    }
  } catch (err) { next(err); }
});

export default router;
