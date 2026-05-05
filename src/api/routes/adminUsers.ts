import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { hashPassword, type AdminRole } from '../../services/adminAuth.service';
import { logAudit } from '../../services/audit.service';

const router = Router();
const VALID_ROLES: AdminRole[] = ['superadmin', 'editor', 'coin_admin'];

// GET /api/admin-users
router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, role, is_active AS "isActive",
              created_at AS "createdAt", last_login_at AS "lastLoginAt"
       FROM admin_users
       ORDER BY id ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin-users
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { username, password, role } = req.body as { username?: string; password?: string; role?: AdminRole };
    if (!username || !password || !role) {
      res.status(400).json({ error: 'username, password, role обязательны' });
      return;
    }
    if (!VALID_ROLES.includes(role)) {
      res.status(400).json({ error: `role должен быть одним из: ${VALID_ROLES.join(', ')}` });
      return;
    }
    if (password.length < 4) {
      res.status(400).json({ error: 'Пароль должен быть минимум 4 символа' });
      return;
    }
    const uname = username.trim().toLowerCase();
    const hash = hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO admin_users (username, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, username, role, is_active AS "isActive", created_at AS "createdAt"`,
      [uname, hash, role]
    );
    res.status(201).json(rows[0]);
    logAudit('admin_user_create', { username: uname, role }, req.ip).catch(() => {});
  } catch (err) {
    if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
      res.status(409).json({ error: 'Пользователь с таким именем уже существует' });
      return;
    }
    next(err);
  }
});

// PUT /api/admin-users/:id  — изменить роль, статус или пароль
router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }

    const { role, isActive, password } = req.body as { role?: AdminRole; isActive?: boolean; password?: string };

    // Защита от self-lock-out и потери последнего суперадмина.
    // Если меняется role на не-superadmin или isActive на false — проверяем,
    // что после этого останется хотя бы один активный суперадмин.
    const isDemotion = (role !== undefined && role !== 'superadmin') || isActive === false;
    if (isDemotion) {
      const { rows: target } = await pool.query<{ role: AdminRole; isActive: boolean }>(
        `SELECT role, is_active AS "isActive" FROM admin_users WHERE id = $1`, [id]
      );
      if (!target[0]) { res.status(404).json({ error: 'Не найден' }); return; }

      // Только если цель — действующий суперадмин и понижается/деактивируется
      if (target[0].role === 'superadmin' && target[0].isActive) {
        const { rows: count } = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM admin_users
           WHERE role = 'superadmin' AND is_active = true AND id <> $1`,
          [id]
        );
        if (parseInt(count[0].n, 10) === 0) {
          res.status(400).json({ error: 'Нельзя понизить или отключить последнего активного суперадмина' });
          return;
        }
      }

      // Защита от self-lock-out: запрещаем менять СВОЮ роль или активность
      // (себя нельзя ни понизить, ни выключить — даже если есть другие супера)
      if (req.adminUserId === id) {
        res.status(400).json({ error: 'Нельзя изменить свою роль или статус — попроси другого суперадмина' });
        return;
      }
    }

    const sets: string[] = [];
    const vals: (string | boolean | number)[] = [];

    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        res.status(400).json({ error: `role должен быть одним из: ${VALID_ROLES.join(', ')}` });
        return;
      }
      vals.push(role); sets.push(`role = $${vals.length}`);
    }
    if (isActive !== undefined) {
      vals.push(isActive); sets.push(`is_active = $${vals.length}`);
    }
    if (password !== undefined) {
      if (password.length < 4) {
        res.status(400).json({ error: 'Пароль должен быть минимум 4 символа' });
        return;
      }
      vals.push(hashPassword(password));
      sets.push(`password_hash = $${vals.length}`);
      // Если суперадмин сбрасывает пароль — требуем сменить при первом входе
      sets.push(`must_change_password = true`);
    }
    if (sets.length === 0) { res.status(400).json({ error: 'Нечего обновлять' }); return; }

    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE admin_users SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, username, role, is_active AS "isActive"`,
      vals
    );
    if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }
    res.json(rows[0]);
    logAudit('admin_user_update', { adminUserId: id, role, isActive, passwordChanged: password !== undefined }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

// DELETE /api/admin-users/:id  — нельзя удалить себя или последнего суперадмина
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }

    if (req.adminUserId === id) {
      res.status(400).json({ error: 'Нельзя удалить самого себя' });
      return;
    }

    const { rows: target } = await pool.query<{ role: AdminRole }>(
      `SELECT role FROM admin_users WHERE id = $1`, [id]
    );
    if (!target[0]) { res.status(404).json({ error: 'Не найден' }); return; }

    if (target[0].role === 'superadmin') {
      const { rows: count } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM admin_users WHERE role = 'superadmin' AND is_active = true AND id <> $1`,
        [id]
      );
      if (parseInt(count[0].n, 10) === 0) {
        res.status(400).json({ error: 'Нельзя удалить последнего суперадмина' });
        return;
      }
    }

    await pool.query(`DELETE FROM admin_users WHERE id = $1`, [id]);
    res.json({ ok: true });
    logAudit('admin_user_delete', { adminUserId: id }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
