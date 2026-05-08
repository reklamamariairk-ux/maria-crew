// /api/v1/notifications — inbox для мобильного и Telegram-клиентов.
// Авторизация — JWT сотрудника.

import { Router, Request, Response, NextFunction } from 'express';
import { employeeAuth } from '../middleware/employeeAuth';
import {
  listNotifications, countUnread, markAsRead, markAllAsRead,
} from '../../services/notification.service';

const router = Router();

router.use(employeeAuth);

// GET /api/v1/notifications — последние 50, плюс счётчик непрочитанных
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = parseInt(String(req.query.limit ?? '50'), 10) || 50;
    const [items, unread] = await Promise.all([
      listNotifications(req.employeeId!, limit),
      countUnread(req.employeeId!),
    ]);
    res.json({ items, unread });
  } catch (err) { next(err); }
});

// POST /api/v1/notifications/read-all
router.post('/read-all', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const updated = await markAllAsRead(req.employeeId!);
    res.json({ ok: true, updated });
  } catch (err) { next(err); }
});

// POST /api/v1/notifications/read — body: {ids: number[]}
router.post('/read', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { ids } = req.body as { ids?: number[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids обязательны' });
      return;
    }
    const validIds = ids.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0);
    const updated = await markAsRead(req.employeeId!, validIds);
    res.json({ ok: true, updated });
  } catch (err) { next(err); }
});

export default router;
