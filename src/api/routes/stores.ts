import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { logAudit } from '../../services/audit.service';
import { fetchGis2Rating, refreshAllGis2Ratings, discoverGis2IdsForAllStores } from '../../services/gis2.service';

const router = Router();

// GET /api/stores
router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, address, gis2_id AS "gis2Id", is_active AS "isActive" FROM stores ORDER BY id`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/stores/:id/employees
router.get('/:id/employees', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, role, is_active AS "isActive", joined_at AS "joinedAt"
       FROM employees WHERE store_id = $1 ORDER BY name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/stores/:id/stats/:year/:month
router.get('/:id/stats/:year/:month', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id, year, month } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM store_monthly_stats WHERE store_id = $1 AND year = $2 AND month = $3`,
      [id, year, month]
    );
    res.json(rows[0] ?? null);
  } catch (err) { next(err); }
});

// POST /api/stores — создать точку
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, address } = req.body as { name: string; address?: string };
    if (!name || !name.trim()) { res.status(400).json({ error: 'name обязателен' }); return; }
    if (name.trim().length > 100) {
      res.status(400).json({ error: 'name слишком длинный (максимум 100 символов)' });
      return;
    }
    const { rows } = await pool.query(
      `INSERT INTO stores (name, address) VALUES ($1, $2)
       RETURNING id, name, address, is_active AS "isActive"`,
      [name.trim(), address?.trim() || null]
    );
    res.status(201).json(rows[0]);
    logAudit('store_create', { storeId: rows[0].id, name: rows[0].name }).catch(() => {});
  } catch (err) { next(err); }
});

// GET /api/stores/:id/gis2-rating — получить текущий рейтинг из 2ГИС
router.get('/:id/gis2-rating', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // pool.query auto-camelize'ит ключи: колонка gis2_id приходит как gis2Id
    const { rows } = await pool.query<{ gis2Id: string | null }>(
      `SELECT gis2_id FROM stores WHERE id = $1`, [req.params.id]
    );
    const gis2Id = rows[0]?.gis2Id ?? null;
    if (!gis2Id) { res.status(400).json({ error: 'У точки не задан 2ГИС ID' }); return; }
    // Рейтинг идёт через прокси sales-dashboard (см. gis2.service), GIS2_API_KEY больше не нужен
    const rating = await fetchGis2Rating(gis2Id);
    if (rating === null) { res.status(502).json({ error: 'Не удалось получить рейтинг из 2ГИС' }); return; }
    res.json({ rating });
  } catch (err) { next(err); }
});

// PUT /api/stores/:id — обновить точку
router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as { name?: string; address?: string | null; gis2Id?: string | null; isActive?: boolean };
    const sets: string[] = [];
    const vals: (string | boolean | null)[] = [];

    if ('name' in body && body.name !== undefined) {
      const trimmed = body.name.trim();
      if (!trimmed) { res.status(400).json({ error: 'name не может быть пустым' }); return; }
      if (trimmed.length > 100) {
        res.status(400).json({ error: 'name слишком длинный (максимум 100 символов)' });
        return;
      }
      vals.push(trimmed); sets.push(`name = $${vals.length}`);
    }
    if ('address' in body) {
      vals.push(body.address ?? null); sets.push(`address = $${vals.length}`);
    }
    if ('gis2Id' in body) {
      vals.push(body.gis2Id ?? null); sets.push(`gis2_id = $${vals.length}`);
    }
    if ('isActive' in body && body.isActive !== undefined) {
      vals.push(body.isActive); sets.push(`is_active = $${vals.length}`);
    }
    if (!sets.length) { res.status(400).json({ error: 'Нечего обновлять' }); return; }

    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE stores SET ${sets.join(', ')}
       WHERE id = $${vals.length}
       RETURNING id, name, address, gis2_id AS "gis2Id", is_active AS "isActive"`,
      vals
    );
    if (!rows[0]) { res.status(404).json({ error: 'Точка не найдена' }); return; }
    res.json(rows[0]);
    logAudit('store_update', { storeId: rows[0].id, changes: body }).catch(() => {});
  } catch (err) { next(err); }
});

// POST /api/stores/discover-gis2-ids — автоматически найти gis2_id по адресу
// для всех активных точек, у которых ID ещё не задан.
router.post('/discover-gis2-ids', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await discoverGis2IdsForAllStores();
    res.json(result);
    logAudit('store_update', { type: 'discover_gis2_ids', found: result.found }).catch(() => {});
  } catch (err) { next(err); }
});

// POST /api/stores/refresh-gis2-ratings — массово обновить рейтинг 2ГИС у всех точек
// Body опционально: { year, month }. Без них — текущий период.
router.post('/refresh-gis2-ratings', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { year, month } = req.body as { year?: number; month?: number };
    const result = await refreshAllGis2Ratings(year, month);
    res.json(result);
    logAudit('store_ratings_save', {
      year: result.year, month: result.month, count: result.updated,
    }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
