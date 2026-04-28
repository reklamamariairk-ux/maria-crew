import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { logAudit } from '../../services/audit.service';
import { sendBroadcast } from '../../bot/notifications/sender';

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
    if (!['all', 'store', 'employee'].includes(target)) {
      res.status(400).json({ error: 'target должен быть: all, store, employee' }); return;
    }
    if (target === 'store' && !storeId) {
      res.status(400).json({ error: 'storeId обязателен при target=store' }); return;
    }
    if (target === 'employee' && !employeeId) {
      res.status(400).json({ error: 'employeeId обязателен при target=employee' }); return;
    }

    let rows: { telegramId: string }[];
    if (target === 'all') {
      const r = await pool.query<{ telegramId: string }>(
        `SELECT telegram_id::text AS "telegramId" FROM employees
         WHERE is_active = true AND telegram_id IS NOT NULL`
      );
      rows = r.rows;
    } else if (target === 'store') {
      const r = await pool.query<{ telegramId: string }>(
        `SELECT telegram_id::text AS "telegramId" FROM employees
         WHERE is_active = true AND telegram_id IS NOT NULL AND store_id = $1`,
        [storeId]
      );
      rows = r.rows;
    } else {
      const r = await pool.query<{ telegramId: string }>(
        `SELECT telegram_id::text AS "telegramId" FROM employees
         WHERE id = $1 AND telegram_id IS NOT NULL`,
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
    }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
