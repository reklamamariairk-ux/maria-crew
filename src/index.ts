import dotenv from 'dotenv';
dotenv.config();

import { pool } from './db/pool';
import { createBot } from './bot/bot';
import { createServer } from './server';
import { initNotifications } from './bot/notifications/sender';
import { initScheduler } from './scheduler/index';
import fs from 'fs';
import path from 'path';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN не задан');

const port = parseInt(process.env.PORT ?? '3000', 10);

// URL сервиса на Render (нужен для webhook)
const serviceUrl = (process.env.WEBHOOK_URL ?? 'https://maria-crew.onrender.com').replace(/\/$/, '');

// Секрет для webhook-эндпоинта (первые 16 символов после ":" в токене)
const webhookSecret = token.split(':')[1]?.slice(0, 16) ?? 'secret';

console.log('=== STARTUP ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', port);
console.log('SERVICE_URL:', serviceUrl);
console.log('BOT_TOKEN:', token.slice(0, 10) + '...');

async function runMigrations(): Promise<void> {
  console.log('[migrations] Запуск...');
  const MIGRATIONS_DIR = path.join(__dirname, '../migrations');
  const client = await pool.connect();
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
    client.release();
  }
}

async function seedIfEmpty(): Promise<void> {
  const { rows } = await pool.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM stores');
  const cnt = parseInt(rows[0]?.cnt ?? '0', 10);
  console.log(`[seed] Магазинов в БД: ${cnt}`);
  if (cnt > 0) return;

  console.log('[seed] Заполняем начальные данные...');
  const client = await pool.connect();
  try {
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
    for (let i = 0; i < 4; i++) {
      const lim = [['Ice Breaker', 'summer'], ['Upsale King', 'autumn'], ['Holiday Star', 'winter'], ['Rookie of Season', 'spring']];
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
    await client.query('ROLLBACK');
    console.error('[seed] ОШИБКА:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  // 1. Миграции
  await runMigrations();

  // 2. Seed
  await seedIfEmpty();

  // 3. Создаём бота
  console.log('[bot] Создаём...');
  const bot = createBot(token!);

  // Проверяем токен
  const me = await bot.api.getMe();
  console.log(`[bot] ✓ @${me.username} (id=${me.id})`);

  initNotifications(bot);
  initScheduler(bot);

  // 4. Запускаем HTTP-сервер с webhook-обработчиком
  const app = createServer(bot, webhookSecret);
  await new Promise<void>(resolve => app.listen(port, () => {
    console.log(`[server] ✓ Порт ${port}`);
    resolve();
  }));

  // 5. Регистрируем webhook в Telegram
  const webhookUrl = `${serviceUrl}/webhook/${webhookSecret}`;
  await bot.api.setWebhook(webhookUrl, { drop_pending_updates: false });
  console.log(`[bot] ✓ Webhook установлен: ${webhookUrl}`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
