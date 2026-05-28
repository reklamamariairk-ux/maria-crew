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
      const { phone, email } = req.body as { phone?: string; email?: string };
      if (!phone && !email) {
        res.status(400).json({ error: 'phone или email обязателен' });
        return;
      }
      const result = await requestPin({ phone, email });
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
      if (result.email && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
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

// POST /api/v1/auth/login-by-phone — упрощённый логин без PIN.
// ВНИМАНИЕ: меньше безопасности, использовать только для внутренних
// сотрудников Маши. Любой кто знает телефон сможет войти.
// Rate-limit 100/час с IP — несколько сотрудников могут логиниться
// с одного офисного Wi-Fi.
router.post(
  '/login-by-phone',
  rateLimit(100, 60 * 60 * 1000),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { phone } = req.body as { phone?: string };
      if (!phone || !phone.trim()) {
        res.status(400).json({ error: 'phone обязателен' });
        return;
      }
      const { loginByPhoneNoPin } = await import('../../services/employeeAuth.service');
      const result = await loginByPhoneNoPin(phone.trim());
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

// Verify: rate limit 20 попыток в час с IP
router.post(
  '/verify-pin',
  rateLimit(20, 60 * 60 * 1000),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { phone, email, pin } = req.body as { phone?: string; email?: string; pin?: string };
      if ((!phone && !email) || !pin) {
        res.status(400).json({ error: 'phone или email + pin обязательны' });
        return;
      }
      const result = await verifyPinAndIssueToken({ phone, email, pin });
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
      if (!name || !storeId) {
        res.status(400).json({ error: 'name и storeId обязательны' });
        return;
      }
      if (!phone && !email) {
        res.status(400).json({ error: 'Нужен телефон или email' });
        return;
      }
      const result = await registerNewEmployee({ phone, email, name, storeId: Number(storeId) });
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

// POST /api/v1/auth/set-email — привязка email прямо из login screen,
// для случая когда у сотрудника нет ни email ни Telegram-привязки.
// После привязки сразу шлёт PIN на этот email.
//
// Безопасность: позволяем установить email только если он ещё не задан.
// Дальнейшая смена — только через залогиненный профиль (PATCH /account).
router.post(
  '/set-email',
  rateLimit(10, 60 * 60 * 1000),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { phone, email } = req.body as { phone?: string; email?: string };
      if (!phone || !email) { res.status(400).json({ error: 'phone и email обязательны' }); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        res.status(400).json({ error: 'Неверный формат email' }); return;
      }
      const { normalizePhone } = await import('../../services/employeeAuth.service');
      const phoneNorm = normalizePhone(phone);
      if (phoneNorm.length !== 11) { res.status(400).json({ error: 'Неверный телефон' }); return; }
      const emailNorm = email.trim().toLowerCase();

      // Ищем сотрудника по телефону
      const { rows } = await pool.query<{ id: number; email: string | null; telegramId: string | null }>(
        `SELECT id, email, telegram_id::text AS "telegramId"
         FROM employees WHERE phone_normalized = $1 AND is_active = true LIMIT 1`,
        [phoneNorm]
      );
      const emp = rows[0];
      if (!emp) { res.status(404).json({ error: 'Сотрудник с таким телефоном не найден' }); return; }
      if (emp.email) {
        res.status(409).json({ error: 'Email уже задан. Войди и поменяй его в профиле.' });
        return;
      }

      // Email не должен быть занят кем-то ещё
      const { rows: dup } = await pool.query<{ id: number }>(
        `SELECT id FROM employees WHERE LOWER(email) = $1 AND id <> $2`,
        [emailNorm, emp.id]
      );
      if (dup[0]) { res.status(409).json({ error: 'Этот email уже занят другим сотрудником' }); return; }

      await pool.query(`UPDATE employees SET email = $1 WHERE id = $2`, [emailNorm, emp.id]);

      // Сразу шлём PIN на новый email (если Gmail SMTP настроен)
      if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
        const result = await requestPin({ phone });
        if ('error' in result) {
          // email сохранили, но pin не послали — попросим юзера запросить ещё раз
          res.json({ ok: true, emailSaved: true, pinSent: false, error: result.error });
          return;
        }
        const { subject, html } = buildLoginPinEmail(result.pin);
        const sendRes = await sendEmail(emailNorm, subject, html);
        res.json({ ok: true, emailSaved: true, pinSent: sendRes.ok, ttlSeconds: result.ttlSeconds });
      } else {
        res.json({ ok: true, emailSaved: true, pinSent: false, error: 'Email-сервис пока не настроен на сервере' });
      }
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
