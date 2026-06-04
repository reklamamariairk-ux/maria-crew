// Бэкап БД в JSON: читаем все таблицы и сериализуем. Формат портативный —
// можно restore'нуть в любую Postgres-базу (миграции применяются отдельно).
//
// Размер выгрузки: для 16 точек × ~10 сотрудников × год активности ~5-15 МБ.
// Хорошо сжимается gzip'ом до ~1-3 МБ.

import { pool } from '../db/pool';

// Список таблиц В ПОРЯДКЕ зависимостей (для восстановления).
// При INSERT сначала идут «родители» (stores), потом «дети» (employees, и т.д.).
const TABLES = [
  'stores',
  'heroes',
  'prize_categories', // до prizes: prizes.category_id → FK сюда
  'prizes',
  'mvp_config',
  'seasonal_challenges',
  'quiz_questions',
  'employees',
  'admin_users',
  'employee_cards',
  'coin_transactions',
  'monthly_metrics',
  'store_monthly_stats',
  'store_exchanges',
  'daily_checkins',
  'quiz_attempts',
  'quiz_sessions',
  'seasonal_challenge_entries',
  'admin_audit_log',
  'notifications',
  'auth_pins',
  'device_tokens',
  // Месенджер (миграции 045-052) — родитель employee_requests, потом дети
  'employee_requests',
  'request_targets',
  'request_notifications',
  'request_responses',
  'request_employee_views',
] as const;

// У junction-таблиц нет колонки id (составной PK) — для них свой ORDER BY.
const ORDER_BY: Record<string, string> = {
  request_targets: 'request_id, employee_id',
  request_employee_views: 'request_id, employee_id',
};

export interface BackupResult {
  version: number;
  createdAt: string;
  rowCounts: Record<string, number>;
  tables: Record<string, unknown[]>;
}

export async function createBackup(): Promise<BackupResult> {
  const result: BackupResult = {
    version: 1,
    createdAt: new Date().toISOString(),
    rowCounts: {},
    tables: {},
  };

  for (const table of TABLES) {
    try {
      // Проверка существования таблицы — на случай если миграция ещё не применилась
      // или используется старая версия схемы.
      const exists = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1
         ) AS exists`,
        [table]
      );
      if (!exists.rows[0]?.exists) {
        result.tables[table] = [];
        result.rowCounts[table] = 0;
        continue;
      }

      const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY ${ORDER_BY[table] ?? 'id'}`);
      result.tables[table] = rows;
      result.rowCounts[table] = rows.length;
    } catch (err) {
      console.error(`[backup] ${table} failed:`, err instanceof Error ? err.message : err);
      // Не падаем — пишем что таблица не выгружена и идём дальше
      result.tables[table] = [];
      result.rowCounts[table] = -1; // -1 значит ошибка чтения
    }
  }

  return result;
}
