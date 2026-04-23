import { Router, Request, Response } from 'express';
import { pool } from '../../db/pool';

const router = Router();

// GET /api/stores — все точки
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT id, name, address, is_active FROM stores ORDER BY id`
  );
  res.json(rows);
});

// GET /api/stores/:id/employees — сотрудники точки
router.get('/:id/employees', async (req: Request, res: Response): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT id, name, role, is_active, joined_at FROM employees
     WHERE store_id = $1 ORDER BY name`,
    [req.params.id]
  );
  res.json(rows);
});

// GET /api/stores/:id/stats/:year/:month — агрегаты точки за месяц
router.get('/:id/stats/:year/:month', async (req: Request, res: Response): Promise<void> => {
  const { id, year, month } = req.params;
  const { rows } = await pool.query(
    `SELECT * FROM store_monthly_stats WHERE store_id = $1 AND year = $2 AND month = $3`,
    [id, year, month]
  );
  res.json(rows[0] ?? null);
});

export default router;
