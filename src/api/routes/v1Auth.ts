// /api/v1/auth — авторизация сотрудников для мобильного приложения.
//
// Поток:
//   POST /api/v1/auth/request-pin   {phone}        → бот шлёт 6-значный код в Telegram
//   POST /api/v1/auth/verify-pin    {phone, pin}   → JWT (30 дней) + employee
//   GET  /api/v1/auth/me            (Bearer)       → текущий сотрудник
//   POST /api/v1/auth/logout        (Bearer)       → no-op (фронт удаляет токен)

import { Router, Request, Response, NextFunction } from 'express';
import { rateLimit } from '../middleware/rateLimit';
import { employeeAuth } from '../middleware/employeeAuth';
import { requestPin, verifyPinAndIssueToken, registerNewEmployee } from '../../services/employeeAuth.service';
import { sendLoginPin, notifyManagersOfNewEmployee } from '../../bot/notifications/sender';
import { sendEmail, buildLoginPinEmail } from '../../services/email.service';
import { pool } from '../../db/pool';

const router = Router();

// ── PIN ────────────────────────────────────────────────────────────────────

// Rate limit: запросов PIN не больше 10 в час с IP — мягкая защита от перебора
// (cooldown per phone — 60 сек, реализован внутри сервиса)
router.post(
  '/request-pin',
  rateLimit(10, 60 * 60 * 1000),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { phone } = req.body as { phone?: string };
      if (!phone || typeof phone !== 'string') {
        res.status(400).json({ error: 'phone обязателен' });
        return;
      }
      const result = await requestPin(phone);
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      // Параллельно отправляем PIN через все доступные каналы.
      // Считаем успехом если хотя бы один канал доставил.
      const channels: string[] = [];
      const tasks: Promise<boolean>[] = [];

      if (result.telegramChatId) {
        tasks.push(sendLoginPin(result.telegramChatId, result.pin).then(ok => {
          if (ok) channels.push('Telegram');
          return ok;
        }));
      }
      if (result.email && process.env.RESEND_API_KEY) {
        const { subject, html } = buildLoginPinEmail(result.pin);
        tasks.push(sendEmail(result.email, subject, html).then(r => {
          if (r.ok) channels.push('Email');
          return r.ok;
        }));
      }
      const sent = (await Promise.all(tasks)).some(Boolean);

      if (!sent) {
        res.status(502).json({ error: 'Не удалось отправить код. Попробуй через минуту.' });
        return;
      }
      res.json({
        ok: true,
        ttlSeconds: result.ttlSeconds,
        channels, // куда отправили (для UI: «Код отправлен в Telegram и SMS»)
      });
    } catch (err) { next(err); }
  }
);

// Verify: rate limit 20 попыток в час с IP
router.post(
  '/verify-pin',
  rateLimit(20, 60 * 60 * 1000),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { phone, pin } = req.body as { phone?: string; pin?: string };
      if (!phone || !pin) {
        res.status(400).json({ error: 'phone и pin обязательны' });
        return;
      }
      const result = await verifyPinAndIssueToken(phone, pin);
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        employeeId: result.employeeId,
      });
    } catch (err) { next(err); }
  }
);

// POST /api/v1/auth/register — регистрация нового сотрудника без Telegram.
// Rate limit 5 регистраций в час с IP — мягкая защита от спама.
router.post(
  '/register',
  rateLimit(5, 60 * 60 * 1000),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { phone, name, storeId, email } = req.body as { phone?: string; name?: string; storeId?: number; email?: string };
      if (!phone || !name || !storeId) {
        res.status(400).json({ error: 'phone, name и storeId обязательны' });
        return;
      }
      const result = await registerNewEmployee({ phone, name, storeId: Number(storeId), email });
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        employeeId: result.employeeId,
      });
      // Async: уведомление менеджерам точки и владельцу — без блокировки ответа
      notifyManagersOfNewEmployee(result.employeeId, Number(storeId)).catch(() => { /* not critical */ });
    } catch (err) { next(err); }
  }
);

// GET /api/v1/auth/stores — публичный список активных точек для дропдауна
// при регистрации (без auth — нужен до того как юзер вошёл).
router.get('/stores', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rows } = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM stores WHERE is_active = true ORDER BY id`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── Авторизованные эндпоинты ──────────────────────────────────────────────

router.get('/me', employeeAuth, async (req: Request, res: Response): Promise<void> => {
  res.json(req.employeeFromMobile);
});

router.post('/logout', employeeAuth, async (_req: Request, res: Response): Promise<void> => {
  // Stateless JWT — серверу нечего удалять. Фронт просто стирает токен.
  // Если в будущем понадобится server-side blacklist — тут добавляется.
  res.json({ ok: true });
});

export default router;
