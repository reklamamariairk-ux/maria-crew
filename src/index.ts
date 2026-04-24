import dotenv from 'dotenv';
dotenv.config();

import { pool } from './db/pool';
import { createBot } from './bot/bot';
import { createServer } from './server';
import { initNotifications } from './bot/notifications/sender';
import { initScheduler } from './scheduler';
import fs from 'fs';
import path from 'path';

console.log('=== ENV CHECK ===');
console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? 'SET (' + process.env.BOT_TOKEN.slice(0, 10) + '...)' : 'NOT SET');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET (' + process.env.DATABASE_URL.slice(0, 30) + '...)' : 'NOT SET');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', process.env.PORT);
console.log('All keys:', Object.keys(process.env).filter(k => !k.includes('npm')).join(', '));
console.log('=================');

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN не задан');

const port = parseInt(process.env.PORT ?? '3000', 10);

console.log('DATABASE_URL:', process.env.DATABASE_URL ? process.env.DATABASE_URL.slice(0, 40) + '...' : 'НЕ ЗАДАН');

async function runMigrations(): Promise<void> {
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
    console.log(count > 0 ? `✓ Применено миграций: ${count}` : '✓ Миграции актуальны');
  } finally {
    client.release();
  }
}

async function seedIfEmpty(): Promise<void> {
  const { rows } = await pool.query<{ cnt: string }>('SELECT COUNT(*) AS cnt FROM stores');
  if (parseInt(rows[0].cnt) > 0) return;

  console.log('  → Таблицы пустые, запускаем начальные данные...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 12 героев
    const heroes = [
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

    // 4 лимитных героя
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

    // 16 точек «Мария»
    for (let i = 1; i <= 16; i++) {
      await client.query(
        `INSERT INTO stores (name, address) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [`Кондитерская «Мария» #${i}`, `Иркутск, точка ${i}`]
      );
    }

    // Призы Maria Store
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
        `INSERT INTO prizes (name, prize_type, cards_required, coins_required, sort_order)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [name, type, cards, coins, order]
      );
    }

    await client.query('COMMIT');
    console.log('✓ Начальные данные добавлены (16 точек, 16 героев, 10 призов)');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  await runMigrations();
  await seedIfEmpty();

  const app = createServer();
  app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);

    const bot = createBot(token!);
    initNotifications(bot);
    initScheduler(bot);

    bot.start({
      onStart: info => console.log(`Бот @${info.username} запущен`),
    }).catch(err => {
      console.error('Ошибка бота:', err.message);
    });
  });
}

main().catch(err => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
