/* Тестовая БД через pg-mem (in-memory PostgreSQL).
 * Создаёт минимальную схему — таблицы, нужные для интеграционных тестов сервисов.
 * Каждый describe-блок создаёт свежий экземпляр через newTestPool(). */

import { newDb, IMemoryDb } from 'pg-mem';

export interface TestPool {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
  connect: () => Promise<{
    query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
    release: () => void;
  }>;
}

export function newTestPool(): { pool: TestPool; db: IMemoryDb } {
  const db = newDb();

  // pg-mem из коробки реализует NOW(). AT TIME ZONE не поддерживает —
  // тесты, использующие this, опускаются (тестируем логику кода, не SQL).

  // Создаём схему (упрощённую для тестов)
  db.public.none(`
    CREATE TABLE IF NOT EXISTS stores (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      gis2_id TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      telegram_username TEXT,
      telegram_photo_url TEXT,
      name TEXT NOT NULL,
      store_id INT REFERENCES stores(id),
      role TEXT NOT NULL DEFAULT 'employee',
      phone TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      joined_at DATE,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS coin_transactions (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      amount INT NOT NULL,
      reason TEXT NOT NULL,
      ref_id INT,
      note TEXT,
      created_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS heroes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      is_limited BOOLEAN NOT NULL DEFAULT false,
      season TEXT,
      sort_order INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS employee_cards (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      hero_id INT REFERENCES heroes(id),
      is_mvp BOOLEAN NOT NULL DEFAULT false,
      source TEXT NOT NULL,
      year INT NOT NULL,
      month INT NOT NULL,
      is_spent BOOLEAN NOT NULL DEFAULT false,
      earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prizes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      prize_type TEXT NOT NULL,
      cards_required INT NOT NULL DEFAULT 0,
      coins_required INT NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INT DEFAULT 0,
      external_items JSONB,
      external_product_id TEXT,
      external_product_name TEXT
    );

    CREATE TABLE IF NOT EXISTS store_exchanges (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      prize_id INT REFERENCES prizes(id),
      cards_spent INT NOT NULL DEFAULT 0,
      coins_spent INT NOT NULL DEFAULT 0,
      card_ids INT[],
      prize_name TEXT,
      prize_type TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      processed_by INT,
      external_doc_id TEXT,
      external_doc_status TEXT,
      external_doc_error TEXT,
      external_doc_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS daily_checkins (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      checkin_date DATE NOT NULL DEFAULT CURRENT_DATE,
      streak_day INT NOT NULL DEFAULT 1,
      coins_earned INT NOT NULL DEFAULT 0,
      UNIQUE(employee_id, checkin_date)
    );

    CREATE TABLE IF NOT EXISTS quiz_questions (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      options JSONB NOT NULL,
      correct_index INT NOT NULL,
      category TEXT NOT NULL DEFAULT 'product',
      is_active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      question_id INT REFERENCES quiz_questions(id),
      is_correct BOOLEAN NOT NULL,
      coins_earned INT NOT NULL DEFAULT 0,
      answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS monthly_metrics (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      store_id INT REFERENCES stores(id),
      year INT NOT NULL,
      month INT NOT NULL,
      mystery_shopper_score NUMERIC,
      reviews_count INT DEFAULT 0,
      checklist_percent NUMERIC,
      revenue_percent NUMERIC,
      mvp_score NUMERIC,
      is_mvp BOOLEAN DEFAULT false,
      cards_awarded JSONB,
      processed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(employee_id, year, month)
    );
  `);

  // Адаптируем pg-mem под pg.Pool API + camelize (как в нашем pool.ts).
  function camelize(s: string): string {
    return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }
  function camelizeRows(rows: Record<string, unknown>[]): unknown[] {
    return rows.map(row => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[camelize(k)] = v;
      return out;
    });
  }

  const adapter = db.adapters.createPg();
  const realPool = new adapter.Pool();

  const pool: TestPool = {
    async query(sql: string, values?: unknown[]) {
      const result = await realPool.query(sql, values);
      return { rows: camelizeRows(result.rows ?? []), rowCount: result.rowCount };
    },
    async connect() {
      const client = await realPool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const r = await client.query(sql, values);
          return { rows: camelizeRows(r.rows ?? []), rowCount: r.rowCount };
        },
        release: () => client.release(),
      };
    },
  };

  return { pool, db };
}

/** Хелпер: создаёт точку и сотрудника в тестовой БД. Возвращает их ID. */
export async function seedEmployee(pool: TestPool, opts: { name?: string; storeId?: number } = {}): Promise<{ employeeId: number; storeId: number }> {
  let storeId = opts.storeId;
  if (!storeId) {
    const { rows } = await pool.query(`INSERT INTO stores (name) VALUES ('Тест точка') RETURNING id`);
    storeId = (rows[0] as { id: number }).id;
  }
  const { rows } = await pool.query(
    `INSERT INTO employees (name, store_id) VALUES ($1, $2) RETURNING id`,
    [opts.name ?? 'Тест Иван', storeId]
  );
  return { employeeId: (rows[0] as { id: number }).id, storeId };
}
