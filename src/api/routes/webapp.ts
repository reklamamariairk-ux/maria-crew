import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { getBalance, getHistory, getMonthlySummary } from '../../services/coin.service';
import { getDailyQuestionsWithAnswers, submitAnswer } from '../../services/quiz.service';
import { getStreak, doCheckin } from '../../services/streak.service';
import { getActiveChallenges, checkAndCompleteChallenge } from '../../services/challenge.service';
import { getAvailableCardCount } from '../../services/card.service';
import { getPrizes, requestExchange, getExchangeHistory } from '../../services/exchange.service';
import { notifyAdminNewExchange } from '../../bot/notifications/sender';
import { getEmployeeLeaderboard, getStoreLeaderboard } from '../../services/rating.service';
import { markWebappAuth } from '../../diagnostics';
import { verifyEmployeeToken } from '../../services/employeeAuth.service';
import { listNotifications, countUnread, markAllAsRead, markAsRead } from '../../services/notification.service';
import { normalizePhone } from '../../services/employeeAuth.service';
import {
  listEmployeeRequests, getEmployeeRequestThread,
  sendEmployeeMessage, getEmployeeUnreadCount,
  createEmployeeInitiatedRequest,
} from '../../services/employeeChat.service';

const router = Router();

// ── initData validation ───────────────────────────────────────────────────────

function validateInitData(initData: string): Record<string, string> | null {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN!)
    .digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Constant-time сравнение подписи (как везде в проекте — timingSafeEqual)
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // NB: auth_date-проверку (24ч) убрали — Telegram Desktop/Web переиспользуют
  // initData с фиксированным (старым) auth_date между запусками → окно рубило
  // реальные логины. Реплей-защита тут низкоценна: подделка требует валидного
  // HMAC (= BOT_TOKEN), которым подписывается вся строка.
  return Object.fromEntries(params.entries());
}

function parseTgUser(data: Record<string, string>): { id: number; username?: string; firstName: string; lastName?: string; photoUrl?: string } | null {
  try {
    const u = JSON.parse(data.user ?? 'null');
    if (!u?.id) return null;
    return {
      id: u.id,
      username: u.username?.toLowerCase(),
      firstName: u.first_name ?? 'Сотрудник',
      lastName: u.last_name,
      photoUrl: u.photo_url,
    };
  } catch { return null; }
}

type Employee = {
  id: number;
  name: string;
  storeId: number;
  storeName: string;
  telegramId: number;
  telegramUsername?: string;
  telegramPhotoUrl?: string;
  role: string;
  phone?: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withDbRetry<T>(label: string, fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1) {
        console.log(`[webapp] ${label}: retry ${attempt}/${attempts}`);
      }
      return await fn();
    } catch (err) {
      lastError = err;
      console.error(`[webapp] ${label}:`, err instanceof Error ? err.message : err);
      if (attempt < attempts) {
        await sleep(1500 * attempt);
      }
    }
  }

  throw lastError;
}

async function getEmployee(telegramId: number): Promise<Employee | null> {
  const { rows } = await withDbRetry('getEmployee', () => pool.query<Employee>(
    `SELECT e.id, e.name, e.store_id AS "storeId", s.name AS "storeName",
            e.telegram_id AS "telegramId", e.telegram_username AS "telegramUsername",
            e.telegram_photo_url AS "telegramPhotoUrl", e.role, e.phone, e.email
     FROM employees e JOIN stores s ON s.id = e.store_id
     WHERE e.telegram_id = $1 AND e.is_active = true`,
    [telegramId]
  ));
  return rows[0] ?? null;
}

/** Канал, которым сотрудник зашёл: Telegram Mini App (initData) или APK (Bearer JWT). */
export type SeenChannel = 'tg' | 'app';

async function touchLastSeen(employeeId: number, channel: SeenChannel, photoUrl?: string): Promise<void> {
  try {
    const channelCol = channel === 'app' ? 'last_seen_app_at' : 'last_seen_tg_at';
    if (photoUrl) {
      await pool.query(
        `UPDATE employees SET last_seen_at = NOW(), ${channelCol} = NOW(), telegram_photo_url = $2 WHERE id = $1`,
        [employeeId, photoUrl]
      );
    } else {
      await pool.query(
        `UPDATE employees SET last_seen_at = NOW(), ${channelCol} = NOW() WHERE id = $1`,
        [employeeId]
      );
    }
  } catch (err) {
    console.error('[webapp] touchLastSeen failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Принимает либо Telegram initData (заголовок Authorization: tma <initData>),
 * либо JWT мобильного приложения (Authorization: Bearer <token>).
 *
 * Для JWT user-объект синтезируется из employee-данных — клиенту неважно,
 * какой метод аутентификации использовался, поля те же.
 */
async function requireAuth(req: Request, res: Response): Promise<{ user: { id: number; username?: string; firstName: string; lastName?: string; photoUrl?: string }; employee: Employee; channel: SeenChannel } | null> {
  const raw = req.headers.authorization ?? '';

  // 1. Bearer JWT (mobile / standalone web client)
  if (raw.startsWith('Bearer ')) {
    const token = raw.slice(7);
    const payload = verifyEmployeeToken(token);
    if (!payload) {
      res.status(401).json({ error: 'Неверный токен' });
      return null;
    }
    const { rows } = await pool.query<Employee>(
      `SELECT e.id, e.name, e.store_id AS "storeId", s.name AS "storeName",
              e.telegram_id AS "telegramId", e.telegram_username AS "telegramUsername",
              e.telegram_photo_url AS "telegramPhotoUrl", e.role, e.phone, e.email
       FROM employees e LEFT JOIN stores s ON s.id = e.store_id
       WHERE e.id = $1 AND e.is_active = true`,
      [payload.uid]
    );
    if (!rows[0]) {
      res.status(403).json({ error: 'Сотрудник деактивирован' });
      return null;
    }
    const employee = rows[0];
    const user = {
      id: Number(employee.telegramId ?? employee.id),
      username: employee.telegramUsername ?? undefined,
      firstName: employee.name,
      photoUrl: employee.telegramPhotoUrl ?? undefined,
    };
    return { user, employee, channel: 'app' };
  }

  // 2. Telegram initData (Mini App внутри Telegram)
  const initData = raw.startsWith('tma ') ? raw.slice(4) : raw;
  const data = validateInitData(initData);
  if (!data) {
    res.status(401).json({ error: 'Неверная подпись initData' });
    return null;
  }
  const user = parseTgUser(data);
  if (!user) {
    res.status(401).json({ error: 'Нет данных пользователя' });
    return null;
  }
  const employee = await getEmployee(user.id);
  if (!employee) {
    res.status(403).json({ error: 'Не зарегистрирован', notRegistered: true });
    return null;
  }
  return { user, employee, channel: 'tg' };
}

async function getStats(empId: number) {
  const now = new Date();
  const [availableCards, coinBalance, heroRows, monthlyRows] = await Promise.all([
    getAvailableCardCount(empId),
    getBalance(empId),
    pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT ec.hero_id) AS count
       FROM employee_cards ec JOIN heroes h ON h.id = ec.hero_id
       WHERE ec.employee_id = $1 AND h.is_limited = false`,
      [empId]
    ),
    getMonthlySummary(empId, now.getFullYear(), now.getMonth() + 1),
  ]);
  return {
    availableCards,
    coinBalance,
    uniqueHeroes: parseInt(heroRows.rows[0]?.count ?? '0', 10),
    monthlyEarned: monthlyRows.earned,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/webapp/auth
router.post('/auth', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    markWebappAuth('auth:start');

    const { initData } = req.body as { initData?: string };
    if (!initData) {
      markWebappAuth('auth:missing_init_data');
      res.status(400).json({ error: 'initData обязателен' });
      return;
    }

    const data = validateInitData(initData);
    if (!data) {
      markWebappAuth('auth:invalid_signature', { initDataLength: initData.length });
      res.status(401).json({ error: 'Неверная подпись initData' });
      return;
    }

    const user = parseTgUser(data);
    if (!user) {
      markWebappAuth('auth:no_user');
      res.status(400).json({ error: 'Нет данных пользователя' });
      return;
    }

    markWebappAuth('auth:validated', { userId: user.id, username: user.username ?? null });

    // Load employee + stats in the same request so the frontend skips a separate /me call
    let employee: Employee | null = null;
    let stats: Awaited<ReturnType<typeof getStats>> | null = null;
    try {
      employee = await getEmployee(user.id);
      if (employee) {
        await touchLastSeen(employee.id, 'tg', user.photoUrl);
        if (user.photoUrl && employee.telegramPhotoUrl !== user.photoUrl) {
          employee.telegramPhotoUrl = user.photoUrl;
        }
        stats = await getStats(employee.id);
      }
    } catch (err) {
      console.error('[webapp] auth: employee preload failed:', err instanceof Error ? err.message : err);
    }

    res.json({ ok: true, user, employee, stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markWebappAuth('auth:error', { message });
    if (/timeout|terminating connection|ECONNRESET|57P01|Connection terminated|connect/i.test(message)) {
      res.status(503).json({ error: 'База данных Maria Crew просыпается. Попробуй ещё раз через несколько секунд.' });
      return;
    }
    next(err);
  }
});

// GET /api/webapp/stores
router.get('/stores', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM stores WHERE is_active = true ORDER BY id`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/webapp/register
router.post('/register', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const raw = req.headers.authorization ?? '';
    const initData = raw.startsWith('tma ') ? raw.slice(4) : raw;
    const data = validateInitData(initData);
    if (!data) { res.status(401).json({ error: 'Неверная подпись' }); return; }

    const user = parseTgUser(data);
    if (!user) { res.status(400).json({ error: 'Нет данных пользователя' }); return; }

    const { storeId } = req.body as { storeId: number };
    if (!storeId) { res.status(400).json({ error: 'storeId обязателен' }); return; }

    const { rows: storeRows } = await pool.query(`SELECT id FROM stores WHERE id = $1`, [storeId]);
    if (!storeRows[0]) { res.status(404).json({ error: 'Точка не найдена' }); return; }

    // Check if pre-added by username
    let employee = await getEmployee(user.id);
    if (!employee && user.username) {
      const { rows } = await withDbRetry('register-link-by-username', () => pool.query<{ id: number }>(
        `UPDATE employees SET telegram_id = $1, store_id = $2, telegram_photo_url = $4
         WHERE LOWER(telegram_username) = $3 AND telegram_id IS NULL AND is_active = true
         RETURNING id`,
        [user.id, storeId, user.username, user.photoUrl ?? null]
      ));
      if (rows[0]) employee = await getEmployee(user.id);
    }

    if (!employee) {
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Сотрудник';
      const { rows } = await withDbRetry('register-insert-employee', () => pool.query<{ id: number }>(
        `INSERT INTO employees (telegram_id, telegram_username, telegram_photo_url, name, store_id, joined_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
         ON CONFLICT (telegram_id) DO UPDATE SET
           store_id = EXCLUDED.store_id,
           telegram_photo_url = COALESCE(EXCLUDED.telegram_photo_url, employees.telegram_photo_url)
         RETURNING id`,
        [user.id, user.username ?? null, user.photoUrl ?? null, fullName, storeId]
      ));
      employee = await getEmployee(user.id);
    }

    if (!employee) { res.status(500).json({ error: 'Ошибка регистрации' }); return; }

    await touchLastSeen(employee.id, 'tg', user.photoUrl);
    if (user.photoUrl && employee.telegramPhotoUrl !== user.photoUrl) {
      employee.telegramPhotoUrl = user.photoUrl;
    }

    const stats = await getStats(employee.id);
    res.json({ employee, stats });
  } catch (err) { next(err); }
});

// GET /api/webapp/me
router.get('/me', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    markWebappAuth('me:start');
    const auth = await requireAuth(req, res);
    if (!auth) return;
    await touchLastSeen(auth.employee.id, auth.channel, auth.user.photoUrl);
    const stats = await getStats(auth.employee.id);
    markWebappAuth('me:ok', { userId: auth.user.id, employeeId: auth.employee.id });
    res.json({ ...auth.employee, ...stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markWebappAuth('me:error', { message });
    if (/timeout|terminating connection|ECONNRESET|57P01|Connection terminated|connect/i.test(message)) {
      res.status(503).json({ error: 'Данные Maria Crew ещё загружаются. Попробуй ещё раз через несколько секунд.' });
      return;
    }
    next(err);
  }
});

// GET /api/webapp/collection
router.get('/collection', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const [heroRows, cardRows] = await Promise.all([
      pool.query(
        `SELECT id, name, description, sort_order AS "sortOrder",
                is_limited AS "isLimited", image_url AS "imageUrl"
         FROM heroes ORDER BY sort_order`
      ),
      pool.query<{ heroId: number; total: number; available: number; hasMvp: boolean }>(
        `SELECT hero_id                                    AS "heroId",
                COUNT(*)::int                              AS total,
                COUNT(*) FILTER (WHERE is_spent = false)::int AS available,
                bool_or(is_mvp)                            AS "hasMvp"
         FROM employee_cards WHERE employee_id = $1
         GROUP BY hero_id`,
        [auth.employee.id]
      ),
    ]);

    const counts = Object.fromEntries(
      cardRows.rows.map(c => [c.heroId, { total: c.total, available: c.available }])
    );
    const owned  = cardRows.rows.map(c => c.heroId);
    const mvpIds = cardRows.rows.filter(c => c.hasMvp).map(c => c.heroId);

    res.json({ heroes: heroRows.rows, owned, mvpIds, counts });
  } catch (err) { next(err); }
});

// GET /api/webapp/collection/hero/:id — детали по конкретному герою
router.get('/collection/hero/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const heroId = parseInt(req.params.id, 10);
    if (Number.isNaN(heroId)) { res.status(400).json({ error: 'Неверный id' }); return; }

    const [heroRows, cardRows] = await Promise.all([
      pool.query(
        `SELECT id, name, description, is_limited AS "isLimited", image_url AS "imageUrl"
         FROM heroes WHERE id = $1`,
        [heroId]
      ),
      pool.query(
        `SELECT id, source, is_mvp AS "isMvp", is_spent AS "isSpent",
                year, month, earned_at AS "earnedAt"
         FROM employee_cards
         WHERE employee_id = $1 AND hero_id = $2
         ORDER BY earned_at DESC`,
        [auth.employee.id, heroId]
      ),
    ]);

    if (!heroRows.rows[0]) { res.status(404).json({ error: 'Герой не найден' }); return; }
    res.json({ hero: heroRows.rows[0], cards: cardRows.rows });
  } catch (err) { next(err); }
});

// GET /api/webapp/coins
router.get('/coins', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const now = new Date();
    const [balance, history, monthly] = await Promise.all([
      getBalance(auth.employee.id),
      getHistory(auth.employee.id, 30),
      getMonthlySummary(auth.employee.id, now.getFullYear(), now.getMonth() + 1),
    ]);

    res.json({ balance, monthly: monthly.earned, monthlySpent: monthly.spent, history });
  } catch (err) { next(err); }
});

// GET /api/webapp/rating
router.get('/rating', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const now = new Date();
    const [ranking, storesRanking] = await Promise.all([
      getEmployeeLeaderboard(auth.employee.storeId, now.getFullYear(), now.getMonth() + 1),
      getStoreLeaderboard(now.getFullYear(), now.getMonth() + 1),
    ]);
    const idx = ranking.findIndex(r => r.employeeId === auth.employee.id);
    const myRank = idx >= 0 ? idx + 1 : null;

    res.json({ ranking, myRank, stores: storesRanking, myStoreId: auth.employee.storeId });
  } catch (err) { next(err); }
});

// GET /api/webapp/prizes
router.get('/prizes', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const prizes = await getPrizes();
    res.json(prizes);
  } catch (err) { next(err); }
});

// GET /api/webapp/quiz/daily
router.get('/quiz/daily', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const result = await getDailyQuestionsWithAnswers(auth.employee.id);
    // Strip correctIndex before sending — client submits answers one-by-one
    res.json({
      alreadyDone: result.alreadyDone,
      answeredToday: result.answeredToday,
      totalToday: result.totalToday,
      questions: result.questions.map(q => ({ id: q.id, question: q.question, options: q.options, category: q.category })),
    });
  } catch (err) { next(err); }
});

// POST /api/webapp/quiz/answer
router.post('/quiz/answer', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { questionId, answerIndex } = req.body as { questionId: number; answerIndex: number };
    if (questionId === undefined || answerIndex === undefined) {
      res.status(400).json({ error: 'questionId и answerIndex обязательны' });
      return;
    }
    const result = await submitAnswer(auth.employee.id, questionId, answerIndex);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/webapp/streak
router.get('/streak', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const streak = await getStreak(auth.employee.id);
    // Заодно проверяем, прошёл ли сотрудник квиз сегодня — нужно для daily-actions-bar.
    // Считаем по иркутскому дню, как и сам квиз.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM quiz_attempts
       WHERE employee_id = $1
         AND (answered_at AT TIME ZONE 'Asia/Irkutsk')::date = (NOW() AT TIME ZONE 'Asia/Irkutsk')::date`,
      [auth.employee.id]
    );
    const quizAnsweredToday = parseInt(rows[0]?.count ?? '0', 10);
    res.json({ ...streak, quizAnsweredToday, quizDoneToday: quizAnsweredToday >= 5 });
  } catch (err) { next(err); }
});

// POST /api/webapp/checkin
router.post('/checkin', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const result = await doCheckin(auth.employee.id);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/webapp/challenge — возвращает массив challenges и (для обратной
// совместимости со старыми клиентами) поле challenge = challenges[0].
router.get('/challenge', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const challenges = await getActiveChallenges(auth.employee.id);
    res.json({ challenges, challenge: challenges[0] ?? null });
  } catch (err) { next(err); }
});

// POST /api/webapp/challenge/check
router.post('/challenge/check', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { challengeId } = req.body as { challengeId: number };
    if (!challengeId) { res.status(400).json({ error: 'challengeId обязателен' }); return; }
    const completed = await checkAndCompleteChallenge(auth.employee.id, challengeId);
    res.json({ completed });
  } catch (err) { next(err); }
});

// PATCH /api/webapp/account — редактирование своего профиля.
// Работает и через Telegram initData, и через Bearer JWT (requireAuth держит оба).
router.patch('/account', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const employeeId = auth.employee.id;

    const { name, phone, avatarUrl, email } = req.body as {
      name?: string; phone?: string; avatarUrl?: string | null; email?: string | null;
    };

    const sets: string[] = [];
    const vals: (string | null | number)[] = [];

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 100) { res.status(400).json({ error: 'Имя должно быть от 1 до 100 символов' }); return; }
      vals.push(trimmed); sets.push(`name = $${vals.length}`);
    }

    if (phone !== undefined) {
      const phoneNorm = normalizePhone(phone);
      if (phoneNorm.length !== 11) { res.status(400).json({ error: 'Неверный формат телефона. Введи 11 цифр' }); return; }
      const { rows: dup } = await pool.query<{ id: number }>(
        `SELECT id FROM employees WHERE phone_normalized = $1 AND id <> $2`,
        [phoneNorm, employeeId]
      );
      if (dup[0]) { res.status(409).json({ error: 'Этот номер уже занят другим сотрудником' }); return; }
      vals.push('+' + phoneNorm); sets.push(`phone = $${vals.length}`);
      vals.push(phoneNorm); sets.push(`phone_normalized = $${vals.length}`);
    }

    if (email !== undefined) {
      const trimmed = email && email.trim() ? email.trim().toLowerCase() : null;
      if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        res.status(400).json({ error: 'Неверный формат email' });
        return;
      }
      if (trimmed) {
        const { rows: dup } = await pool.query<{ id: number }>(
          `SELECT id FROM employees WHERE LOWER(email) = $1 AND id <> $2`,
          [trimmed, employeeId]
        );
        if (dup[0]) { res.status(409).json({ error: 'Этот email уже занят' }); return; }
      }
      vals.push(trimmed); sets.push(`email = $${vals.length}`);
    }

    if (avatarUrl !== undefined) {
      const url = avatarUrl && avatarUrl.trim() ? avatarUrl.trim() : null;
      vals.push(url); sets.push(`telegram_photo_url = $${vals.length}`);
    }

    if (sets.length === 0) { res.status(400).json({ error: 'Нечего обновлять' }); return; }

    vals.push(employeeId);
    const { rows } = await pool.query(
      `UPDATE employees SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, name, phone, email, telegram_photo_url AS "telegramPhotoUrl",
                 store_id AS "storeId", role`,
      vals
    );
    if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/webapp/feedback — фидбэк/багрепорт сотрудника владельцу в Telegram.
// Принимает оба способа auth (initData в Mini App, Bearer в standalone/мобилке).
router.post('/feedback', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const employeeId = auth.employee.id;
    const { message, context } = req.body as { message?: string; context?: Record<string, unknown> };
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'Сообщение обязательно' });
      return;
    }
    if (message.length > 4000) {
      res.status(400).json({ error: 'Слишком длинное сообщение (макс 4000 символов)' });
      return;
    }

    const ownerId = process.env.OWNER_TELEGRAM_ID;
    if (!ownerId) {
      console.error('[feedback] OWNER_TELEGRAM_ID не задан, фидбэк потерян:', { employeeId, message });
      res.json({ ok: true, delivered: false });
      return;
    }

    const { sendBroadcast } = await import('../../bot/notifications/sender');
    const platform = typeof context?.platform === 'string' ? context.platform : 'unknown';
    const version = typeof context?.version === 'string' ? context.version : '?';
    const screen = typeof context?.screen === 'string' ? context.screen : '';
    const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const text =
      `📝 <b>Фидбэк от сотрудника</b>\n\n` +
      `<b>Сотрудник:</b> ${escHtml(auth.employee.name)} (id=${employeeId})\n` +
      `<b>Точка:</b> ${escHtml(auth.employee.storeName ?? '—')}\n` +
      `<b>Платформа:</b> ${escHtml(platform)}\n` +
      `<b>Версия:</b> ${escHtml(version)}\n` +
      (screen ? `<b>Экран:</b> ${escHtml(screen)}\n` : '') +
      `\n<b>Сообщение:</b>\n${escHtml(message.trim())}`;

    const result = await sendBroadcast([ownerId], text, { parseMode: 'HTML' });
    res.json({ ok: true, delivered: result.sent > 0 });
  } catch (err) { next(err); }
});

// ── Inbox уведомлений (доступен и из Telegram Mini App, и из мобилки) ────

// GET /api/webapp/notifications
router.get('/notifications', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const limit = parseInt(String(req.query.limit ?? '50'), 10) || 50;
    const [items, unread] = await Promise.all([
      listNotifications(auth.employee.id, limit),
      countUnread(auth.employee.id),
    ]);
    res.json({ items, unread });
  } catch (err) { next(err); }
});

router.post('/notifications/read-all', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const updated = await markAllAsRead(auth.employee.id);
    res.json({ ok: true, updated });
  } catch (err) { next(err); }
});

router.post('/notifications/read', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { ids } = req.body as { ids?: number[] };
    if (!Array.isArray(ids) || ids.length === 0) { res.status(400).json({ error: 'ids обязательны' }); return; }
    const validIds = ids.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0);
    const updated = await markAsRead(auth.employee.id, validIds);
    res.json({ ok: true, updated });
  } catch (err) { next(err); }
});

// GET /api/webapp/exchanges/my — история заявок сотрудника
router.get('/exchanges/my', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const exchanges = await getExchangeHistory(auth.employee.id, 30);
    res.json({ exchanges });
  } catch (err) { next(err); }
});

// POST /api/webapp/exchange
router.post('/exchange', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { prizeId } = req.body as { prizeId: number };
    if (!prizeId) { res.status(400).json({ error: 'prizeId обязателен' }); return; }

    const exchange = await requestExchange(auth.employee.id, prizeId);
    res.status(201).json(exchange);
    notifyAdminNewExchange(auth.employee.id, exchange.id).catch(() => {});
  } catch (err) { next(err); }
});

// ── Чат с руководителем (запросы-диалоги) ─────────────────────────────────────

// GET /api/webapp/messages — список диалогов с превью + unread
router.get('/messages', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const items = await listEmployeeRequests(auth.employee.id);
    res.json({ items });
  } catch (err) { next(err); }
});

// POST /api/webapp/messages/new — сотрудник создаёт новый диалог с руководителем
router.post('/messages/new', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const body = req.body as {
      text?: string;
      fileUrl?: string;
      fileThumbnailUrl?: string;
      fileType?: 'photo' | 'video' | 'document';
      fileName?: string;
    };
    if (!body.text?.trim() && !body.fileUrl) {
      res.status(400).json({ error: 'Нужен текст или файл' }); return;
    }
    const result = await createEmployeeInitiatedRequest({
      employeeId: auth.employee.id,
      text: body.text || '',
      fileUrl: body.fileUrl,
      fileThumbnailUrl: body.fileThumbnailUrl,
      fileType: body.fileType,
      fileName: body.fileName,
    });
    res.json(result);
    // Уведомляем менеджеров в TG (async, не блокирует ответ)
    notifyManagersOfEmployeeMessage(auth.employee.name, body.text || '', body.fileType, true).catch(() => {});
  } catch (err) { next(err); }
});

// Уведомление менеджерам о сообщении сотрудника (новый диалог или ответ в треде).
// Раньше шло только на OWNER_TELEGRAM_ID, которого нет в env → не уходило никому.
async function notifyManagersOfEmployeeMessage(empName: string, text: string, fileType: string | undefined, isNew: boolean): Promise<void> {
  const { notifyAllManagers } = await import('../../bot/notifications/sender');
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fileLabel = fileType === 'photo' ? '📷 фото' : fileType === 'video' ? '🎬 видео' : fileType === 'document' ? '📎 файл' : '';
  const preview = text.trim() ? esc(text.slice(0, 100)) : fileLabel;
  const html =
    `📨 <b>${isNew ? 'Новое сообщение от сотрудника' : 'Ответ сотрудника в чате'}</b>\n\n` +
    `От: <b>${esc(empName)}</b>\n` +
    `Сообщение: ${preview}\n\n` +
    `Открыть в админке: https://crew.145-223-121-47.sslip.io/`;
  await notifyAllManagers(html);
}

// GET /api/webapp/messages/unread-count — badge на иконке «Сообщения»
router.get('/messages/unread-count', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const count = await getEmployeeUnreadCount(auth.employee.id);
    res.json({ count });
  } catch (err) { next(err); }
});

// GET /api/webapp/messages/:id — открыть чат конкретного запроса (mark read)
router.get('/messages/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const data = await getEmployeeRequestThread({
      requestId: parseInt(req.params.id, 10),
      employeeId: auth.employee.id,
    });
    if (!data) { res.status(404).json({ error: 'Запрос не найден или нет доступа' }); return; }
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/webapp/messages/:id/send — сотрудник пишет в чат
router.post('/messages/:id/send', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const body = req.body as {
      text?: string;
      fileUrl?: string;
      fileThumbnailUrl?: string;
      fileType?: 'photo' | 'video' | 'document';
      fileName?: string;
    };
    const result = await sendEmployeeMessage({
      requestId: parseInt(req.params.id, 10),
      employeeId: auth.employee.id,
      text: body.text,
      fileUrl: body.fileUrl,
      fileThumbnailUrl: body.fileThumbnailUrl,
      fileType: body.fileType,
      fileName: body.fileName,
    });
    if (!result) { res.status(404).json({ error: 'Запрос не найден или нет доступа' }); return; }
    res.json(result);
    // Уведомляем менеджеров об ответе сотрудника в треде (async)
    notifyManagersOfEmployeeMessage(auth.employee.name, body.text || '', body.fileType, false).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
