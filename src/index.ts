import dotenv from 'dotenv';
dotenv.config();

import { pool } from './db/pool';
import { createBot } from './bot/bot';
import { createServer } from './server';
import { initNotifications } from './bot/notifications/sender';
import { initScheduler } from './scheduler';
import fs from 'fs';
import path from 'path';

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

async function main() {
  await runMigrations();

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
