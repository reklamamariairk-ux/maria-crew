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
import { requestPin, verifyPinAndIssueToken } from '../../services/employeeAuth.service';
import { sendLoginPin } from '../../bot/notifications/sender';

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
      // Отправляем PIN через бота — синхронно, потому что юзер ждёт фидбэка
      const sent = await sendLoginPin(result.telegramChatId, result.pin);
      if (!sent) {
        res.status(502).json({ error: 'Не удалось отправить код в Telegram. Попробуй ещё раз через минуту.' });
        return;
      }
      res.json({ ok: true, ttlSeconds: result.ttlSeconds });
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
