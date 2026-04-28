import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';

const router = Router();

// GET /api/stores
router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rows } = await pool.query(`SELECT id, name, address, is_active AS "isActive" FROM stores ORDER BY id`);
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
    const { rows } = await pool.query(
      `INSERT INTO stores (name, address) VALUES ($1, $2)
       RETURNING id, name, address, is_active AS "isActive"`,
      [name.trim(), address?.trim() || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/stores/:id — обновить точку
router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as { name?: string; address?: string | null; isActive?: boolean };
    const sets: string[] = [];
    const vals: (string | boolean | null)[] = [];

    if ('name' in body && body.name !== undefined) {
      vals.push(body.name); sets.push(`name = $${vals.length}`);
    }
    if ('address' in body) {
      vals.push(body.address ?? null); sets.push(`address = $${vals.length}`);
    }
    if ('isActive' in body && body.isActive !== undefined) {
      vals.push(body.isActive); sets.push(`is_active = $${vals.length}`);
    }
    if (!sets.length) { res.status(400).json({ error: 'Нечего обновлять' }); return; }

    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE stores SET ${sets.join(', ')}
       WHERE id = $${vals.length}
       RETURNING id, name, address, is_active AS "isActive"`,
      vals
    );
    if (!rows[0]) { res.status(404).json({ error: 'Точка не найдена' }); return; }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
