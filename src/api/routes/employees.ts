import { Router, Request, Response } from 'express';
import { pool } from '../../db/pool';
import { getAvailableCardCount } from '../../services/card.service';
import { getBalance } from '../../services/coin.service';

const router = Router();

// GET /api/employees/:id/summary — сводка сотрудника
router.get('/:id/summary', async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);

  const { rows } = await pool.query(
    `SELECT e.*, s.name AS "storeName" FROM employees e
     JOIN stores s ON s.id = e.store_id
     WHERE e.id = $1`,
    [id]
  );
  if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }

  const [cards, coins] = await Promise.all([
    getAvailableCardCount(id),
    getBalance(id),
  ]);

  const { rows: heroRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT ec.hero_id) AS count
     FROM employee_cards ec
     JOIN heroes h ON h.id = ec.hero_id
     WHERE ec.employee_id = $1 AND h.is_limited = false`,
    [id]
  );

  res.json({
    ...rows[0],
    availableCards: cards,
    coinBalance: coins,
    uniqueHeroes: parseInt(heroRows[0]?.count ?? '0', 10),
  });
});

// POST /api/employees — создать сотрудника вручную (без Telegram)
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { name, storeId, role = 'employee', joinedAt } = req.body as {
    name: string; storeId: number; role?: string; joinedAt?: string;
  };

  if (!name || !storeId) { res.status(400).json({ error: 'name и storeId обязательны' }); return; }

  const { rows } = await pool.query(
    `INSERT INTO employees (name, store_id, role, joined_at)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, storeId, role, joinedAt ?? null]
  );
  res.status(201).json(rows[0]);
});

// PUT /api/employees/:id — обновить (деактивировать / сменить точку)
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const { name, storeId, role, isActive } = req.body as {
    name?: string; storeId?: number; role?: string; isActive?: boolean;
  };

  const { rows } = await pool.query(
    `UPDATE employees SET
       name      = COALESCE($1, name),
       store_id  = COALESCE($2, store_id),
       role      = COALESCE($3, role),
       is_active = COALESCE($4, is_active)
     WHERE id = $5 RETURNING *`,
    [name ?? null, storeId ?? null, role ?? null, isActive ?? null, req.params.id]
  );
  if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }
  res.json(rows[0]);
});

export default router;
