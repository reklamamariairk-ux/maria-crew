// /api/v1/feedback — отправка фидбэка/багрепорта из приложения владельцу
// в Telegram. Авторизованные сотрудники могут оставить сообщение, бэк шлёт
// в OWNER_TELEGRAM_ID с контекстом (employeeId, name, точка, версия клиента).

import { Router, Request, Response, NextFunction } from 'express';
import { employeeAuth } from '../middleware/employeeAuth';
import { rateLimit } from '../middleware/rateLimit';
import { pool } from '../../db/pool';

const router = Router();

// rate-limit: не больше 10 фидбэков в час с IP — чтобы не спамили
router.post('/', employeeAuth, rateLimit(10, 60 * 60 * 1000), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { message, context } = req.body as { message?: string; context?: Record<string, unknown> };
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'Сообщение обязательно' });
      return;
    }
    if (message.length > 4000) {
      res.status(400).json({ error: 'Слишком длинное сообщение (макс 4000 символов)' });
      return;
    }

    // Доп. данные сотрудника для контекста
    const { rows } = await pool.query<{ name: string; storeName: string | null }>(
      `SELECT e.name, s.name AS "storeName"
       FROM employees e LEFT JOIN stores s ON s.id = e.store_id
       WHERE e.id = $1`,
      [req.employeeId!]
    );
    const emp = rows[0];

    const ownerId = process.env.OWNER_TELEGRAM_ID;
    if (!ownerId) {
      // Лучше залогировать и ответить «ок» чем 500
      console.error('[feedback] OWNER_TELEGRAM_ID не задан, фидбэк потерян:', { employeeId: req.employeeId, message });
      res.json({ ok: true, delivered: false });
      return;
    }

    // Используем грами бот через global instance из sender.ts
    const { sendBroadcast } = await import('../../bot/notifications/sender');

    // Форматируем сообщение для владельца
    const userAgent = req.headers['user-agent'] ?? '';
    const platform = typeof context?.platform === 'string' ? context.platform : 'unknown';
    const version = typeof context?.version === 'string' ? context.version : '?';
    const screen = typeof context?.screen === 'string' ? context.screen : '';

    // Escape HTML потому что используем parse_mode HTML
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const text =
      `📝 <b>Фидбэк от сотрудника</b>\n\n` +
      `<b>Сотрудник:</b> ${esc(emp?.name ?? '?')} (id=${req.employeeId})\n` +
      `<b>Точка:</b> ${esc(emp?.storeName ?? '—')}\n` +
      `<b>Платформа:</b> ${esc(platform)}\n` +
      `<b>Версия:</b> ${esc(version)}\n` +
      (screen ? `<b>Экран:</b> ${esc(screen)}\n` : '') +
      `<b>UA:</b> <code>${esc(userAgent.slice(0, 100))}</code>\n\n` +
      `<b>Сообщение:</b>\n${esc(message.trim())}`;

    const result = await sendBroadcast([ownerId], text);
    res.json({ ok: true, delivered: result.sent > 0 });
  } catch (err) { next(err); }
});

export default router;
