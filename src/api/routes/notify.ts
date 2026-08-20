import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { logAudit } from '../../services/audit.service';
import { sendBroadcast } from '../../bot/notifications/sender';
import { workspaceForRequest } from '../../services/adminWorkspace.service';

const router = Router();

// POST /api/notify — рассылка сообщений через бота
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { message, target, storeId, employeeId } = req.body as {
      message: string;
      target: 'all' | 'store' | 'employee';
      storeId?: number;
      employeeId?: number;
    };

    if (!message || !message.trim()) {
      res.status(400).json({ error: 'message обязателен' }); return;
    }
    // Telegram limit на одно сообщение — 4096 символов
    if (message.length > 4000) {
      res.status(400).json({ error: 'Сообщение слишком длинное (максимум 4000 символов)' });
      return;
    }
    if (!['all', 'store', 'employee'].includes(target)) {
      res.status(400).json({ error: 'target должен быть: all, store, employee' }); return;
    }
    if (target === 'store' && !storeId) {
      res.status(400).json({ error: 'storeId обязателен при target=store' }); return;
    }
    if (target === 'employee' && !employeeId) {
      res.status(400).json({ error: 'employeeId обязателен при target=employee' }); return;
    }

    const workspace = workspaceForRequest(req);
    const office = workspace === 'office';
    let rows: { telegramId: string }[];
    if (target === 'all') {
      const r = await pool.query<{ telegramId: string }>(
        `SELECT e.telegram_id::text AS "telegramId" FROM employees e
         LEFT JOIN stores s ON s.id = e.store_id
         ${office ? 'LEFT JOIN office_employee_memberships oem ON oem.employee_id = e.id' : ''}
         WHERE e.is_active = true AND e.telegram_id IS NOT NULL
           AND ${office ? `(oem.employee_id IS NOT NULL OR s.workspace = 'office')` : `s.workspace = 'retail'`}`
      );
      rows = r.rows;
    } else if (target === 'store') {
      const r = await pool.query<{ telegramId: string }>(
        `SELECT e.telegram_id::text AS "telegramId" FROM employees e
         LEFT JOIN stores s ON s.id = e.store_id
         ${office ? 'LEFT JOIN office_employee_memberships oem ON oem.employee_id = e.id' : ''}
         WHERE e.is_active = true AND e.telegram_id IS NOT NULL
           AND ${office ? `COALESCE(oem.office_store_id, e.store_id) = $1
             AND (oem.employee_id IS NOT NULL OR s.workspace = 'office')` : `e.store_id = $1 AND s.workspace = 'retail'`}`,
        [storeId]
      );
      rows = r.rows;
    } else {
      const r = await pool.query<{ telegramId: string }>(
        `SELECT e.telegram_id::text AS "telegramId" FROM employees e
         LEFT JOIN stores s ON s.id = e.store_id
         ${office ? 'LEFT JOIN office_employee_memberships oem ON oem.employee_id = e.id' : ''}
         WHERE e.id = $1 AND e.telegram_id IS NOT NULL
           AND ${office ? `(oem.employee_id IS NOT NULL OR s.workspace = 'office')` : `s.workspace = 'retail'`}`,
        [employeeId]
      );
      rows = r.rows;
    }

    const telegramIds = rows.map(r => r.telegramId);
    if (telegramIds.length === 0) {
      res.json({ sent: 0, failed: 0, total: 0, warning: 'Нет получателей с Telegram' });
      return;
    }

    const { sent, failed } = await sendBroadcast(telegramIds, message.trim());
    res.json({ sent, failed, total: telegramIds.length });

    logAudit('broadcast', {
      target, storeId: storeId ?? null, employeeId: employeeId ?? null,
      preview: message.trim().slice(0, 100),
      sent, failed,
      workspace,
    }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
