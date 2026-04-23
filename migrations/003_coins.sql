-- Мария-монеты: append-only ledger (баланс = SUM(amount))

CREATE TYPE coin_reason AS ENUM (
  'checklist_day',  -- чек-лист 100% за день
  'review',         -- именной положительный отзыв
  'cake_order',     -- продажа торта на заказ
  'substitution',   -- подмена коллеги на другой точке
  'mentoring',      -- наставничество (новый сотрудник)
  'idea',           -- идея, которую внедрили
  'spend',          -- списание при обмене в Store
  'manual'          -- ручное начисление/корректировка
);

CREATE TABLE coin_transactions (
  id          SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  amount      INTEGER NOT NULL,         -- >0 начисление, <0 списание
  reason      coin_reason NOT NULL,
  ref_id      INTEGER,                  -- ссылка на monthly_metrics.id или store_exchanges.id
  note        TEXT,
  created_by  INTEGER REFERENCES employees(id),  -- кто начислил
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_coins_employee   ON coin_transactions(employee_id);
CREATE INDEX idx_coins_created_at ON coin_transactions(created_at);
