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

console.log('=== STARTUP ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', port);
console.log('BOT_TOKEN:', token ? token.slice(0, 10) + '...' : 'NOT SET');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? process.env.DATABASE_URL.slice(0, 40) + '...' : 'NOT SET');

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

  console.log('[seed] БД пустая, заполняем начальные данные...');
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
        `INSERT INTO heroes (name, description, sort_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [heroes[i][0], heroes[i][1], i + 1]
      );
    }

    const limited: [string, string][] = [
      ['Ice Breaker', 'summer'], ['Upsale King', 'autumn'],
      ['Holiday Star', 'winter'], ['Rookie of Season', 'spring'],
    ];
    for (let i = 0; i < limited.length; i++) {
      await client.query(
        `INSERT INTO heroes (name, is_limited, season, sort_order) VALUES ($1, true, $2, $3) ON CONFLICT DO NOTHING`,
        [limited[i][0], limited[i][1], 100 + i]
      );
    }

    for (let i = 1; i <= 16; i++) {
      await client.query(
        `INSERT INTO stores (name, address) VALUES ($1, $2)`,
        [`Точка #${i}`, `Иркутск`]
      );
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
    for (const [name, type, cards, coins, order] of prizes) {
      await client.query(
        `INSERT INTO prizes (name, prize_type, cards_required, coins_required, sort_order) VALUES ($1, $2, $3, $4, $5)`,
        [name, type, cards, coins, order]
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

  // 2. Заполнение начальных данных
  await seedIfEmpty();

  // 3. Создаём и проверяем бота ДО старта HTTP-сервера
  console.log('[bot] Инициализация...');
  const bot = createBot(token!);

  // Проверяем токен и подключение к Telegram
  const me = await bot.api.getMe();
  console.log(`[bot] ✓ Подключён: @${me.username} (id=${me.id})`);

  // Удаляем webhook (если был) перед long polling
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  console.log('[bot] ✓ Webhook удалён, pending updates сброшены');

  initNotifications(bot);
  initScheduler(bot);

  // 4. Запускаем HTTP-сервер
  const app = createServer();
  await new Promise<void>(resolve => app.listen(port, () => {
    console.log(`[server] ✓ Слушает порт ${port}`);
    resolve();
  }));

  // 5. Запускаем long polling (блокирующий, поэтому последний)
  console.log('[bot] Запускаем long polling...');
  await bot.start({
    onStart: info => console.log(`[bot] ✓ Polling запущен @${info.username}`),
  });
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
