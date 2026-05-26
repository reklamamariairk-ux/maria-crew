import dotenv from 'dotenv';
dotenv.config();

import { Client } from 'pg';
import { pool } from './db/pool';
import { createBot } from './bot/bot';
import { createServer } from './server';
import { initNotifications } from './bot/notifications/sender';
import { initScheduler } from './scheduler/index';
import { initRequestService } from './services/request.service';
import { effectiveAdminSecret } from './api/middleware/adminAuth';
import { ensureBootstrapSuperadmin } from './services/adminAuth.service';
import { markDbReady, markDbError } from './diagnostics';
import fs from 'fs';
import path from 'path';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN не задан');

const port = parseInt(process.env.PORT ?? '3000', 10);

const serviceUrl = (
  process.env.WEBHOOK_URL ??
  process.env.RENDER_EXTERNAL_URL ??
  'https://crew.145-223-121-47.sslip.io'
).replace(/\/$/, '');

const webhookSecret = token.split(':')[1]?.slice(0, 16) ?? 'secret';

console.log('=== STARTUP ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', port);
console.log('SERVICE_URL:', serviceUrl);
console.log('BOT_TOKEN:', token ? '(set)' : '(empty)');
console.log('ADMIN_SECRET:', process.env.ADMIN_SECRET ? '(из env)' : '(автогенерирован, перезапись сбросит)');
console.log('GMAIL_USER:', process.env.GMAIL_USER ? '(set)' : '(empty)');
console.log('GMAIL_APP_PASSWORD:', process.env.GMAIL_APP_PASSWORD ? '(set)' : '(empty)');
console.log('FIREBASE_SERVICE_ACCOUNT_JSON:', process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? '(set)' : '(empty)');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 3000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (attempt > 1) console.log(`[retry] ${label} — попытка ${attempt}/${attempts}`);
      return await fn();
    } catch (err) {
      lastError = err;
      console.error(`[retry] ${label} — ошибка: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

async function queryWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Query timeout after ${ms}ms`)), ms)
    ),
  ]);
}

// Uses a dedicated Client (not the pool) so a hanging cold-start query
// doesn't occupy a pool slot. Client is destroyed on timeout.
async function checkDatabase(): Promise<void> {
  console.log('[db] Проверяем подключение...');
  const TIMEOUT_MS = 120_000;

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: TIMEOUT_MS,
  });

  let timedOut = false;
  const timer = setTimeout(async () => {
    timedOut = true;
    try { await client.end(); } catch {}
  }, TIMEOUT_MS);

  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (err) {
    clearTimeout(timer);
    try { await client.end(); } catch {}
    if (timedOut) throw new Error(`DB connection timeout after ${TIMEOUT_MS / 1000}s`);
    throw err;
  }

  clearTimeout(timer);
  try { await client.end(); } catch {}
  console.log('[db] ✓ Подключение к БД есть');
}

function makeDirectClient(): import('pg').Client {
  return new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 120_000,
  });
}

async function runMigrations(): Promise<void> {
  console.log('[migrations] Запуск...');
  const MIGRATIONS_DIR = path.join(__dirname, '../migrations');
  const client = makeDirectClient();
  await client.connect();
  try {
    const bootstrap = fs.readFileSync(path.join(MIGRATIONS_DIR, '000_migrations_table.sql'), 'utf8');
    await client.query(bootstrap);

    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    const applied = new Set(rows.map(r => r.filename));

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql') && f !== '000_migrations_table.sql')
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      console.log(`  → migration: ${file}`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log(count > 0 ? `[migrations] ✓ Применено: ${count}` : '[migrations] ✓ Актуальны');
  } finally {
    try { await client.end(); } catch {}
  }
}

async function seedIfEmpty(): Promise<void> {
  const client = makeDirectClient();
  await client.connect();
  try {
    const { rows } = await client.query<{ cnt: string }>(
      'SELECT COUNT(*)::text AS cnt FROM stores'
    );
    const cnt = parseInt(rows[0]?.cnt ?? '0', 10);
    console.log(`[seed] Магазинов в БД: ${cnt}`);
    if (cnt > 0) return;

    console.log('[seed] Заполняем начальные данные...');
    await client.query('BEGIN');

    const heroes: [string, string][] = [
      ['Пекарь Антон',     'Мастер слоёного теста'],
      ['Кондитер Света',   'Королева торта на заказ'],
      ['Баристо Макс',     'Кофейный волшебник'],
      ['Кассир Аня',       'Быстрее всех в кассе'],
      ['Уборщик Гена',     'Идеальный чек-лист каждый день'],
      ['Наставник Ирина',  'Обучила уже 10 новичков'],
      ['Продавец Дима',    'Король апсейла'],
      ['Декоратор Оля',    'Витрина, как в журнале'],
      ['Технолог Борис',   'Хранитель рецептов'],
      ['Логист Женя',      'Всегда вовремя и без потерь'],
      ['Менеджер Катя',    'Лучший тайный покупатель боится'],
      ['Основатель Мария', 'Легендарная карточка. Редкая.'],
    ];
    for (let i = 0; i < heroes.length; i++) {
      await client.query(
        `INSERT INTO heroes (name, description, sort_order) VALUES ($1, $2, $3)`,
        [heroes[i][0], heroes[i][1], i + 1]
      );
    }
    const lim: [string, string][] = [
      ['Ice Breaker', 'summer'], ['Upsale King', 'autumn'],
      ['Holiday Star', 'winter'], ['Rookie of Season', 'spring'],
    ];
    for (let i = 0; i < lim.length; i++) {
      await client.query(
        `INSERT INTO heroes (name, is_limited, season, sort_order) VALUES ($1, true, $2, $3)`,
        [lim[i][0], lim[i][1], 100 + i]
      );
    }
    for (let i = 1; i <= 16; i++) {
      await client.query(`INSERT INTO stores (name, address) VALUES ($1, $2)`, [`Точка #${i}`, `Иркутск`]);
    }
    const prizes: [string, string, number, number, number][] = [
      ['Торт или пирог «Мария»',          'cake',         3,  0,  1],
      ['Сертификат 1 500₽ (Ozon/кино)',   'certificate',  5,  0,  2],
      ['Денежная премия 3 000₽',          'cash',         7,  0,  3],
      ['Премия 5 000₽ + выбор смен',      'shift_choice', 10, 0,  4],
      ['Золотой бейдж 7 000₽ + выходной', 'golden_badge', 12, 0,  5],
      ['Кофе + десерт в «Марии»',         'coffee',       0,  10, 10],
      ['Скидка 30% на торт на заказ',     'discount',     0,  20, 11],
      ['Мерч Maria Crew',                 'merch',        0,  30, 12],
      ['Сертификат 2 000₽ (Ozon/WB)',     'certificate',  0,  50, 13],
      ['Доп. перерыв 15 мин.',            'break',        0,  15, 14],
    ];
    for (const [n, t, c, co, o] of prizes) {
      await client.query(
        `INSERT INTO prizes (name, prize_type, cards_required, coins_required, sort_order) VALUES ($1,$2,$3,$4,$5)`,
        [n, t, c, co, o]
      );
    }
    await client.query('COMMIT');
    console.log('[seed] ✓ Данные добавлены');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[seed] ОШИБКА:', err);
    throw err;
  } finally {
    try { await client.end(); } catch {}
  }
}

// Инициализирует БД в фоне, никогда не крашит процесс.
// Повторяет попытки пока не успеет.
async function initDatabaseBackground(): Promise<void> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await checkDatabase();
      await runMigrations();
      await seedIfEmpty();
      await ensureBootstrapSuperadmin();
      markDbReady();
      console.log('[db] ✓ База данных полностью готова');
      // Warm up the pool so the first API request doesn't hit Neon cold
      pool.query('SELECT 1').then(() => {
        console.log('[pool] ✓ Pool initialized');
      }).catch((e: Error) => {
        console.warn('[pool] Pool warm-up failed:', e.message);
      });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markDbError(msg);
      const delay = Math.min(attempt * 5000, 30000); // 5s, 10s, 15s … max 30s
      console.error(`[db] Попытка ${attempt} не удалась (${msg}), следующая через ${delay / 1000}с`);
      await sleep(delay);
    }
  }
}

async function main() {
  // 1. HTTP-сервер — первым делом, Render следит за портом
  const bot = createBot(token!);
  const app = createServer(bot, webhookSecret);
  await new Promise<void>((resolve, reject) =>
    app.listen(port, () => {
      console.log(`[server] ✓ Порт ${port}`);
      resolve();
    }).on('error', reject)
  );

  // 2. Уведомления и планировщик не требуют БД
  initNotifications(bot);
  initRequestService(bot);
  initScheduler(bot);

  // 3. Webhook устанавливаем ДО ожидания БД — чтобы бот принимал сообщения
  try {
    const me = await withRetry('getMe', () => bot.api.getMe(), { attempts: 10, delayMs: 2000 });
    console.log(`[bot] ✓ @${me.username} (id=${me.id})`);
    const webhookUrl = `${serviceUrl}/webhook/${webhookSecret}`;
    await withRetry('setWebhook', () =>
      bot.api.setWebhook(webhookUrl, { drop_pending_updates: false }),
      { attempts: 10, delayMs: 2000 }
    );
    console.log(`[bot] ✓ Webhook: ${webhookUrl}`);

    // Постоянная кнопка меню внизу чата — открывает Mini App без команд
    const webappUrl = `${serviceUrl}/webapp`;
    await bot.api.setMyDefaultAdministratorRights().catch(() => {});
    await bot.api.setChatMenuButton({
      menu_button: { type: 'web_app', text: '🍰 Maria Crew', web_app: { url: webappUrl } },
    }).catch((e: Error) => console.warn('[bot] setChatMenuButton:', e.message));

    // Список команд в выпадающем «/» меню Telegram
    await bot.api.setMyCommands([
      { command: 'start',      description: 'Главное меню' },
      { command: 'me',         description: 'Мой статус: монеты, карточки, серия' },
      { command: 'collection', description: 'Моя коллекция героев' },
      { command: 'coins',      description: 'Мои монеты' },
      { command: 'rating',     description: 'Рейтинг моей точки' },
      { command: 'top',        description: 'Топ всех точек' },
      { command: 'store',      description: 'Maria Store — обмен на призы' },
      { command: 'crew',       description: 'Команда моей точки' },
    ]).catch((e: Error) => console.warn('[bot] setMyCommands:', e.message));
  } catch (err) {
    // Не падаем — webhook мог быть установлен при прошлом старте
    console.error('[bot] Не удалось установить webhook:', err instanceof Error ? err.message : err);
  }

  // 4. БД инициализируется в фоне, сервер уже принимает запросы
  initDatabaseBackground().catch(err => {
    // этот catch никогда не сработает (цикл бесконечный), но для TypeScript
    console.error('[db] Неожиданный выход из фонового цикла:', err);
  });
}

// Graceful shutdown — Render и Docker шлют SIGTERM при перезапуске/деплое.
// Без обработки активные SQL и Telegram-запросы прерываются на середине.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, gracefully closing...`);
  try {
    const { pool } = await import('./db/pool');
    await pool.end();
    console.log('[shutdown] DB pool closed');
  } catch (err) {
    console.error('[shutdown] pool.end failed:', err instanceof Error ? err.message : err);
  }
  // 5 секунд на in-flight requests, дальше принудительно
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Только фатальные ошибки (например, порт занят) роняют процесс
main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
