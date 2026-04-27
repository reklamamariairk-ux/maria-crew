import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { getBalance, getHistory, getMonthlySummary } from '../../services/coin.service';
import { getAvailableCardCount } from '../../services/card.service';
import { getPrizes, requestExchange } from '../../services/exchange.service';
import { getEmployeeLeaderboard } from '../../services/rating.service';
import { markWebappAuth } from '../../diagnostics';

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

  return computed === hash ? Object.fromEntries(params.entries()) : null;
}

function parseTgUser(data: Record<string, string>): { id: number; username?: string; firstName: string } | null {
  try {
    const u = JSON.parse(data.user ?? 'null');
    if (!u?.id) return null;
    return { id: u.id, username: u.username?.toLowerCase(), firstName: u.first_name ?? 'Сотрудник' };
  } catch { return null; }
}

type Employee = {
  id: number;
  name: string;
  storeId: number;
  storeName: string;
  telegramId: number;
  telegramUsername?: string;
  role: string;
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
            e.telegram_id AS "telegramId", e.telegram_username AS "telegramUsername", e.role
     FROM employees e JOIN stores s ON s.id = e.store_id
     WHERE e.telegram_id = $1 AND e.is_active = true`,
    [telegramId]
  ));
  return rows[0] ?? null;
}

async function requireAuth(req: Request, res: Response): Promise<{ user: { id: number; username?: string; firstName: string }; employee: Employee } | null> {
  const raw = req.headers.authorization ?? '';
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
  return { user, employee };
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
      if (employee) stats = await getStats(employee.id);
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
        `UPDATE employees SET telegram_id = $1, store_id = $2
         WHERE LOWER(telegram_username) = $3 AND telegram_id IS NULL AND is_active = true
         RETURNING id`,
        [user.id, storeId, user.username]
      ));
      if (rows[0]) employee = await getEmployee(user.id);
    }

    if (!employee) {
      const name = user.firstName;
      const { rows } = await withDbRetry('register-insert-employee', () => pool.query<{ id: number }>(
        `INSERT INTO employees (telegram_id, telegram_username, name, store_id, joined_at)
         VALUES ($1, $2, $3, $4, CURRENT_DATE)
         ON CONFLICT (telegram_id) DO UPDATE SET store_id = EXCLUDED.store_id
         RETURNING id`,
        [user.id, user.username ?? null, name, storeId]
      ));
      employee = await getEmployee(user.id);
    }

    if (!employee) { res.status(500).json({ error: 'Ошибка регистрации' }); return; }

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
      pool.query(`SELECT id, name, sort_order, is_limited FROM heroes ORDER BY sort_order`),
      pool.query<{ heroId: number; hasMvp: boolean }>(
        `SELECT hero_id AS "heroId", bool_or(is_mvp) AS "hasMvp"
         FROM employee_cards WHERE employee_id = $1
         GROUP BY hero_id`,
        [auth.employee.id]
      ),
    ]);

    const ownedMap = new Map(cardRows.rows.map(c => [c.heroId, c.hasMvp]));
    const owned = [...ownedMap.keys()];
    const mvpIds = cardRows.rows.filter(c => c.hasMvp).map(c => c.heroId);

    res.json({ heroes: heroRows.rows, owned, mvpIds });
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

    res.json({ balance, monthly: monthly.earned, history });
  } catch (err) { next(err); }
});

// GET /api/webapp/rating
router.get('/rating', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const now = new Date();
    const ranking = await getEmployeeLeaderboard(
      auth.employee.storeId, now.getFullYear(), now.getMonth() + 1
    );
    const myRank = ranking.findIndex(r => r.employeeId === auth.employee.id) + 1;

    res.json({ ranking, myRank: myRank || null });
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

// POST /api/webapp/exchange
router.post('/exchange', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { prizeId } = req.body as { prizeId: number };
    if (!prizeId) { res.status(400).json({ error: 'prizeId обязателен' }); return; }

    const exchange = await requestExchange(auth.employee.id, prizeId);
    res.status(201).json(exchange);
  } catch (err) { next(err); }
});

export default router;
