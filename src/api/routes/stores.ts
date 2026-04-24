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

export default router;
