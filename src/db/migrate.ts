import fs from 'fs';
import path from 'path';
import { pool } from './pool';

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

async function migrate() {
  const client = await pool.connect();
  try {
    // Создаём таблицу миграций если её нет
    const bootstrapSql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '000_migrations_table.sql'),
      'utf8'
    );
    await client.query(bootstrapSql);

    // Получаем уже выполненные миграции
    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    const applied = new Set(rows.map(r => r.filename));

    // Читаем все файлы миграций кроме bootstrap
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql') && f !== '000_migrations_table.sql')
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;

      console.log(`  → applying ${file}`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log(count > 0 ? `✓ Applied ${count} migration(s)` : '✓ No new migrations');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
