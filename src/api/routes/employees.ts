import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { getAvailableCardCount } from '../../services/card.service';
import { getBalance, earn } from '../../services/coin.service';
import { logAudit } from '../../services/audit.service';
import { notifyCoinAward } from '../../bot/notifications/sender';
import { requireRole } from '../middleware/adminAuth';
import { normalizePhone } from '../../services/employeeAuth.service';

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

// GET /api/employees/engagement?days=30&storeId=N — уникальных чек-инов по дням.
// storeId фильтрует по точке сотрудника (для отображения вовлечённости одной точки
// на дашборде, когда выбран фильтр-точка).
router.get('/engagement', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '30'), 10) || 30, 1), 90);
    const storeId = req.query.storeId ? parseInt(String(req.query.storeId), 10) : null;
    const params: (number | null)[] = [days];
    let storeJoin = '';
    let storeWhere = '';
    if (storeId && !isNaN(storeId)) {
      params.push(storeId);
      storeJoin = `JOIN employees e ON e.id = dc.employee_id`;
      storeWhere = `AND e.store_id = $${params.length}`;
    }
    const { rows } = await pool.query<{ date: string; uniqueUsers: string }>(
      `SELECT dc.checkin_date::text AS date, COUNT(DISTINCT dc.employee_id)::text AS "uniqueUsers"
       FROM daily_checkins dc
       ${storeJoin}
       WHERE dc.checkin_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Irkutsk')::date - $1::int
         ${storeWhere}
       GROUP BY dc.checkin_date
       ORDER BY dc.checkin_date ASC`,
      params
    );
    res.json(rows.map(r => ({ date: r.date, uniqueUsers: parseInt(r.uniqueUsers, 10) })));
  } catch (err) { next(err); }
});

// GET /api/employees/summaries — batch-сводка по списку сотрудников.
// Используется в админке вместо N+1 цикла отдельных /summary-запросов.
// ?storeId=N — для фильтра, иначе по всем.
router.get('/summaries', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const storeId = req.query.storeId ? parseInt(String(req.query.storeId), 10) : null;
    const params: number[] = [];
    let where = '';
    if (storeId) { params.push(storeId); where = `WHERE e.store_id = $${params.length}`; }

    // Один запрос — все агрегации сразу через LATERAL/подзапросы.
    // Если 200 сотрудников: одна SQL вместо 600 (200 HTTP × 3 SQL).
    const { rows } = await pool.query<{
      id: number;
      availableCards: string;
      coinBalance: string;
      uniqueHeroes: string;
    }>(
      `SELECT e.id,
              COALESCE((SELECT COUNT(*) FROM employee_cards WHERE employee_id = e.id AND is_spent = false), 0)::text AS "availableCards",
              COALESCE((SELECT SUM(amount) FROM coin_transactions WHERE employee_id = e.id), 0)::text AS "coinBalance",
              COALESCE((SELECT COUNT(DISTINCT ec.hero_id) FROM employee_cards ec
                        JOIN heroes h ON h.id = ec.hero_id
                        WHERE ec.employee_id = e.id AND h.is_limited = false), 0)::text AS "uniqueHeroes"
       FROM employees e
       ${where}`,
      params
    );

    const summaries: Record<number, { availableCards: number; coinBalance: number; uniqueHeroes: number }> = {};
    for (const r of rows) {
      summaries[r.id] = {
        availableCards: parseInt(r.availableCards, 10),
        coinBalance:    parseInt(r.coinBalance, 10),
        uniqueHeroes:   parseInt(r.uniqueHeroes, 10),
      };
    }
    res.json(summaries);
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
              e.phone AS "phone", e.email AS "email",
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

// PATCH /api/employees/:id/name — отдельный эндпоинт только для имени.
// Доступен всем админам (включая coin_admin), потому что переименование —
// безобидная операция (часто требуется поправить опечатку в ФИО), а полный
// PUT остаётся закрытым для coin_admin.
router.patch('/:id/name', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) { res.status(400).json({ error: 'name обязателен' }); return; }
    if (name.trim().length > 100) { res.status(400).json({ error: 'name слишком длинный (максимум 100 символов)' }); return; }
    const { rows } = await pool.query(
      `UPDATE employees SET name = $1 WHERE id = $2 RETURNING *`,
      [name.trim(), id]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }
    res.json(rows[0]);
    logAudit('employee_update', { employeeId: id, name: name.trim(), via: 'patch_name' }).catch(() => {});
  } catch (err) { next(err); }
});

// PUT /api/employees/:id
router.put('/:id', denyCoinAdminForWrites, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, storeId, role, isActive, telegramUsername, phone, email } = req.body as {
      name?: string; storeId?: number; role?: string; isActive?: boolean;
      telegramUsername?: string; phone?: string | null; email?: string | null;
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

    // Нормализация телефона + phone_normalized (через общую функцию из auth-сервиса).
    let phoneFmt: string | null | undefined;
    let phoneNorm: string | null | undefined;
    if (phone !== undefined) {
      if (phone && phone.trim()) {
        const normalized = normalizePhone(phone);
        if (normalized.length !== 11) {
          res.status(400).json({ error: 'Неверный формат телефона (нужно 11 цифр)' });
          return;
        }
        phoneFmt = '+' + normalized;
        phoneNorm = normalized;
      } else {
        phoneFmt = null;
        phoneNorm = null;
      }
    }

    // Нормализация email + проверка дубликата
    let emailNorm: string | null | undefined;
    const empId = parseInt(req.params.id, 10);
    if (isNaN(empId)) { res.status(400).json({ error: 'Неверный id' }); return; }
    if (email !== undefined) {
      if (email && email.trim()) {
        emailNorm = email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
          res.status(400).json({ error: 'Неверный формат email' });
          return;
        }
        const { rows: dup } = await pool.query<{ id: number }>(
          `SELECT id FROM employees WHERE LOWER(email) = $1 AND id <> $2`,
          [emailNorm, empId]
        );
        if (dup[0]) { res.status(409).json({ error: 'Этот email уже занят другим сотрудником' }); return; }
      } else {
        emailNorm = null;
      }
    }

    const { rows } = await pool.query(
      `UPDATE employees SET
         name              = COALESCE($1, name),
         store_id          = COALESCE($2, store_id),
         role              = COALESCE($3, role),
         is_active         = COALESCE($4, is_active),
         telegram_username = COALESCE($5, telegram_username),
         phone             = CASE WHEN $7::boolean THEN $6 ELSE phone END,
         phone_normalized  = CASE WHEN $7::boolean THEN $8 ELSE phone_normalized END,
         email             = CASE WHEN $10::boolean THEN $9 ELSE email END
       WHERE id = $11 RETURNING *`,
      [
        name ?? null, storeId ?? null, role ?? null, isActive ?? null,
        username ?? null,
        phoneFmt ?? null, phone !== undefined, phoneNorm ?? null,
        emailNorm ?? null, email !== undefined,
        empId,
      ]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }
    res.json(rows[0]);

    if (storeId !== undefined) {
      logAudit('employee_store_change', { employeeId: rows[0].id, newStoreId: storeId }).catch(() => {});
    }
    if (isActive !== undefined) {
      logAudit(isActive ? 'employee_activate' : 'employee_deactivate', { employeeId: rows[0].id }).catch(() => {});
    }
    if (name !== undefined || role !== undefined || username !== undefined || phone !== undefined || email !== undefined) {
      logAudit('employee_update', { employeeId: rows[0].id, name, role, telegramUsername: username, phone: phoneNorm, email: emailNorm }).catch(() => {});
    }
  } catch (err) {
    // Преобразуем unique-constraint violation (race condition) в понятный 409.
    // Защищает от ситуации когда два админа одновременно ставят один email
    // разным сотрудникам — БД-индекс idx_employees_email_unique поймает.
    if (err instanceof Error && /unique constraint|duplicate key/i.test(err.message)) {
      if (/email/i.test(err.message)) {
        res.status(409).json({ error: 'Этот email уже занят другим сотрудником' });
        return;
      }
      if (/phone/i.test(err.message)) {
        res.status(409).json({ error: 'Этот телефон уже занят' });
        return;
      }
    }
    next(err);
  }
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
          // Защита от ухода баланса ниже 0: списываем максимум сколько есть (как /award)
          const balance = await getBalance(employeeId);
          if (balance === 0) {
            return { employeeId, ok: false, error: 'Баланс 0 — нечего списывать' };
          }
          const adjusted = -Math.min(Math.abs(amount), balance);
          await pool.query(
            `INSERT INTO coin_transactions (employee_id, amount, reason, note)
             VALUES ($1, $2, 'manual', $3)`,
            [employeeId, adjusted, note ?? null]
          );
          notifyCoinAward(employeeId, adjusted, 'manual', note).catch(() => {});
          return { employeeId, ok: true, amount: adjusted };
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
