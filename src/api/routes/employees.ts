import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { getAvailableCardCount } from '../../services/card.service';
import { getBalance, earn } from '../../services/coin.service';
import { logAudit } from '../../services/audit.service';
import { notifyCoinAward } from '../../bot/notifications/sender';
import { requireRole } from '../middleware/adminAuth';

const router = Router();

// coin_admin не может создавать/менять сотрудников
function denyCoinAdminForWrites(req: Request, res: Response, next: NextFunction): void {
  if (req.adminRole === 'coin_admin') {
    res.status(403).json({ error: 'Эта операция недоступна для роли «Только монеты»' });
    return;
  }
  next();
}

// GET /api/employees?storeId=&recent=1&page=1&pageSize=50
// Если page указан — возвращает {data, total, page, pages}; иначе — массив (backward compat)
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const storeId = req.query.storeId ? parseInt(String(req.query.storeId), 10) : null;
    const recentOnly = String(req.query.recent ?? '') === '1';
    const usePagination = req.query.page !== undefined;

    const params: (number | string)[] = [];
    const wheres: string[] = [];
    if (storeId) { params.push(storeId); wheres.push(`e.store_id = $${params.length}`); }
    if (recentOnly) { wheres.push(`e.last_seen_at IS NOT NULL`); }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const order = recentOnly
      ? `ORDER BY e.last_seen_at DESC NULLS LAST, e.id DESC`
      : `ORDER BY (e.last_seen_at IS NULL), e.last_seen_at DESC, e.name`;

    const base = `SELECT e.id, e.name, e.role,
              e.is_active         AS "isActive",
              e.joined_at         AS "joinedAt",
              e.telegram_id       AS "telegramId",
              e.telegram_username AS "telegramUsername",
              e.telegram_photo_url AS "telegramPhotoUrl",
              e.last_seen_at      AS "lastSeenAt",
              e.phone             AS "phone",
              e.store_id          AS "storeId",
              s.name              AS "storeName"
       FROM employees e
       LEFT JOIN stores s ON s.id = e.store_id
       ${where}
       ${order}`;

    if (usePagination) {
      const pageSize = Math.min(parseInt(String(req.query.pageSize ?? '50'), 10) || 50, 200);
      const page = Math.max(parseInt(String(req.query.page), 10) || 1, 1);
      const offset = (page - 1) * pageSize;

      const [rows, countResult] = await Promise.all([
        pool.query(`${base} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, offset]),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM employees e ${where}`,
          params
        ),
      ]);

      const total = parseInt(countResult.rows[0].count, 10);
      res.json({ data: rows.rows, total, page, pages: Math.ceil(total / pageSize) });
    } else {
      const { rows } = await pool.query(`${base}`, params);
      res.json(rows);
    }
  } catch (err) { next(err); }
});

// GET /api/employees/engagement?days=30 — уникальных чек-инов по дням
router.get('/engagement', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '30'), 10) || 30, 1), 90);
    const { rows } = await pool.query<{ date: string; uniqueUsers: string }>(
      `SELECT checkin_date::text AS date, COUNT(DISTINCT employee_id)::text AS "uniqueUsers"
       FROM daily_checkins
       WHERE checkin_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Irkutsk')::date - $1::int
       GROUP BY checkin_date
       ORDER BY checkin_date ASC`,
      [days]
    );
    res.json(rows.map(r => ({ date: r.date, uniqueUsers: parseInt(r.uniqueUsers, 10) })));
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
              e.phone AS "phone",
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

const VALID_EMPLOYEE_ROLES = new Set(['employee', 'manager', 'admin']);

// POST /api/employees
router.post('/', denyCoinAdminForWrites, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, storeId, role = 'employee', joinedAt, telegramUsername } = req.body as {
      name: string; storeId: number; role?: string; joinedAt?: string; telegramUsername?: string;
    };
    if (!name || !name.trim()) { res.status(400).json({ error: 'name обязателен' }); return; }
    if (name.trim().length > 100) { res.status(400).json({ error: 'name слишком длинный (максимум 100 символов)' }); return; }
    if (!storeId) { res.status(400).json({ error: 'storeId обязателен' }); return; }
    if (!VALID_EMPLOYEE_ROLES.has(role)) {
      res.status(400).json({ error: `role должен быть: ${[...VALID_EMPLOYEE_ROLES].join(', ')}` });
      return;
    }
    const username = telegramUsername ? telegramUsername.replace(/^@/, '').toLowerCase() : null;
    const { rows } = await pool.query(
      `INSERT INTO employees (name, store_id, role, joined_at, telegram_username)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, storeId, role, joinedAt ?? null, username]
    );
    res.status(201).json(rows[0]);
    logAudit('employee_create', { employeeId: rows[0].id, name, storeId, role, telegramUsername: username }).catch(() => {});
  } catch (err) { next(err); }
});

// PUT /api/employees/:id
router.put('/:id', denyCoinAdminForWrites, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, storeId, role, isActive, telegramUsername, phone } = req.body as {
      name?: string; storeId?: number; role?: string; isActive?: boolean;
      telegramUsername?: string; phone?: string | null;
    };
    if (role !== undefined && !VALID_EMPLOYEE_ROLES.has(role)) {
      res.status(400).json({ error: `role должен быть: ${[...VALID_EMPLOYEE_ROLES].join(', ')}` });
      return;
    }
    if (name !== undefined && (!name.trim() || name.trim().length > 100)) {
      res.status(400).json({ error: 'name пустой или слишком длинный' });
      return;
    }
    const username = telegramUsername !== undefined
      ? (telegramUsername ? telegramUsername.replace(/^@/, '').toLowerCase() : null)
      : undefined;
    const phoneNorm = phone !== undefined
      ? (phone && phone.trim() ? phone.trim() : null)
      : undefined;
    const empId = parseInt(req.params.id, 10);
    if (isNaN(empId)) { res.status(400).json({ error: 'Неверный id' }); return; }
    const { rows } = await pool.query(
      `UPDATE employees SET
         name              = COALESCE($1, name),
         store_id          = COALESCE($2, store_id),
         role              = COALESCE($3, role),
         is_active         = COALESCE($4, is_active),
         telegram_username = COALESCE($5, telegram_username),
         phone             = CASE WHEN $7::boolean THEN $6 ELSE phone END
       WHERE id = $8 RETURNING *`,
      [
        name ?? null, storeId ?? null, role ?? null, isActive ?? null,
        username ?? null, phoneNorm ?? null, phoneNorm !== undefined, empId,
      ]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }
    res.json(rows[0]);

    // Аудит
    if (storeId !== undefined) {
      logAudit('employee_store_change', { employeeId: rows[0].id, newStoreId: storeId }).catch(() => {});
    }
    if (isActive !== undefined) {
      logAudit(isActive ? 'employee_activate' : 'employee_deactivate', { employeeId: rows[0].id }).catch(() => {});
    }
    if (name !== undefined || role !== undefined || username !== undefined || phone !== undefined) {
      logAudit('employee_update', { employeeId: rows[0].id, name, role, telegramUsername: username, phone: phoneNorm }).catch(() => {});
    }
  } catch (err) { next(err); }
});

// POST /api/employees/bulk-coins — начислить монеты сразу нескольким сотрудникам
// body: { employeeIds: number[], reason: string, amount?: number, note?: string }
router.post('/bulk-coins', requireRole('superadmin', 'coin_admin'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { employeeIds, reason, amount, note } = req.body as {
      employeeIds: number[]; reason: string; amount?: number; note?: string;
    };
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      res.status(400).json({ error: 'employeeIds обязателен' }); return;
    }
    if (!reason) { res.status(400).json({ error: 'reason обязателен' }); return; }

    const results = await Promise.all(employeeIds.map(async (employeeId) => {
      try {
        if (reason === 'manual' && typeof amount === 'number' && amount < 0) {
          await pool.query(
            `INSERT INTO coin_transactions (employee_id, amount, reason, note)
             VALUES ($1, $2, 'manual', $3)`,
            [employeeId, amount, note ?? null]
          );
          notifyCoinAward(employeeId, amount, 'manual', note).catch(() => {});
          return { employeeId, ok: true, amount };
        }
        const tx = await earn({
          employeeId, reason: reason as Parameters<typeof earn>[0]['reason'], amount, note,
        });
        notifyCoinAward(employeeId, tx.amount, reason, note).catch(() => {});
        return { employeeId, ok: true, amount: tx.amount };
      } catch (err) {
        return { employeeId, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }));

    const succeeded = results.filter(r => r.ok).length;
    res.json({ ok: true, processed: results.length, succeeded, results });
    logAudit('coin_award', { bulk: true, employeeIds, reason, amount, note: note ?? null, succeeded }).catch(() => {});
  } catch (err) { next(err); }
});

// POST /api/employees/bulk-active — массовое активировать/деактивировать
router.post('/bulk-active', denyCoinAdminForWrites, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { employeeIds, isActive } = req.body as { employeeIds: number[]; isActive: boolean };
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      res.status(400).json({ error: 'employeeIds обязателен' }); return;
    }
    if (typeof isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive обязателен' }); return;
    }
    await pool.query(
      `UPDATE employees SET is_active = $1 WHERE id = ANY($2)`,
      [isActive, employeeIds]
    );
    res.json({ ok: true, count: employeeIds.length });
    logAudit(isActive ? 'employee_activate' : 'employee_deactivate', { bulk: true, employeeIds }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
