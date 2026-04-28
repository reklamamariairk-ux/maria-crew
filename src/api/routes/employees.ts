import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { getAvailableCardCount } from '../../services/card.service';
import { getBalance } from '../../services/coin.service';

const router = Router();

// GET /api/employees?storeId=&recent=1
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const storeId = req.query.storeId ? parseInt(String(req.query.storeId), 10) : null;
    const recentOnly = String(req.query.recent ?? '') === '1';

    const params: (number | string)[] = [];
    const wheres: string[] = [];
    if (storeId) { params.push(storeId); wheres.push(`e.store_id = $${params.length}`); }
    if (recentOnly) { wheres.push(`e.last_seen_at IS NOT NULL`); }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const order = recentOnly
      ? `ORDER BY e.last_seen_at DESC NULLS LAST, e.id DESC`
      : `ORDER BY (e.last_seen_at IS NULL), e.last_seen_at DESC, e.name`;

    const { rows } = await pool.query(
      `SELECT e.id, e.name, e.role,
              e.is_active         AS "isActive",
              e.joined_at         AS "joinedAt",
              e.telegram_id       AS "telegramId",
              e.telegram_username AS "telegramUsername",
              e.telegram_photo_url AS "telegramPhotoUrl",
              e.last_seen_at      AS "lastSeenAt",
              e.store_id          AS "storeId",
              s.name              AS "storeName"
       FROM employees e
       LEFT JOIN stores s ON s.id = e.store_id
       ${where}
       ${order}`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/employees/:id/summary
router.get('/:id/summary', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `SELECT e.id, e.name, e.role, e.is_active AS "isActive", e.joined_at AS "joinedAt",
              e.telegram_id AS "telegramId", e.telegram_username AS "telegramUsername",
              e.telegram_photo_url AS "telegramPhotoUrl", e.last_seen_at AS "lastSeenAt",
              e.store_id AS "storeId", s.name AS "storeName"
       FROM employees e JOIN stores s ON s.id = e.store_id
       WHERE e.id = $1`,
      [id]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }

    const [cards, coins] = await Promise.all([getAvailableCardCount(id), getBalance(id)]);
    const { rows: heroRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT ec.hero_id) AS count
       FROM employee_cards ec JOIN heroes h ON h.id = ec.hero_id
       WHERE ec.employee_id = $1 AND h.is_limited = false`,
      [id]
    );
    res.json({
      ...rows[0],
      availableCards: cards,
      coinBalance: coins,
      uniqueHeroes: parseInt(heroRows[0]?.count ?? '0', 10),
    });
  } catch (err) { next(err); }
});

// POST /api/employees
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, storeId, role = 'employee', joinedAt, telegramUsername } = req.body as {
      name: string; storeId: number; role?: string; joinedAt?: string; telegramUsername?: string;
    };
    if (!name || !storeId) { res.status(400).json({ error: 'name и storeId обязательны' }); return; }
    const username = telegramUsername ? telegramUsername.replace(/^@/, '').toLowerCase() : null;
    const { rows } = await pool.query(
      `INSERT INTO employees (name, store_id, role, joined_at, telegram_username)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, storeId, role, joinedAt ?? null, username]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/employees/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, storeId, role, isActive, telegramUsername } = req.body as {
      name?: string; storeId?: number; role?: string; isActive?: boolean; telegramUsername?: string;
    };
    const username = telegramUsername !== undefined
      ? (telegramUsername ? telegramUsername.replace(/^@/, '').toLowerCase() : null)
      : undefined;
    const { rows } = await pool.query(
      `UPDATE employees SET
         name              = COALESCE($1, name),
         store_id          = COALESCE($2, store_id),
         role              = COALESCE($3, role),
         is_active         = COALESCE($4, is_active),
         telegram_username = COALESCE($5, telegram_username)
       WHERE id = $6 RETURNING *`,
      [name ?? null, storeId ?? null, role ?? null, isActive ?? null, username ?? null, req.params.id]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
