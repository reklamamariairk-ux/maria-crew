-- Точки сети и сотрудники

CREATE TABLE stores (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  address     TEXT,
  telegram_chat_id BIGINT UNIQUE,       -- ID канала/чата точки в Telegram
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE employees (
  id          SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE,            -- NULL до первого /start в боте
  name        VARCHAR(100) NOT NULL,
  store_id    INTEGER REFERENCES stores(id),
  role        VARCHAR(20) NOT NULL DEFAULT 'employee'
                CHECK (role IN ('employee', 'manager', 'admin')),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  joined_at   DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_employees_telegram_id ON employees(telegram_id);
CREATE INDEX idx_employees_store_id    ON employees(store_id);
