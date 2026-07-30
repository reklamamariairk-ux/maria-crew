-- Физические призы месяца («торт от Марии»): лучшая точка сети и лучший
-- сотрудник сети. Идемпотентность выдачи — UNIQUE(year, month, kind).
CREATE TABLE IF NOT EXISTS monthly_prizes (
  id          SERIAL PRIMARY KEY,
  year        INT NOT NULL,
  month       INT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('top_store', 'best_employee')),
  store_id    INT REFERENCES stores(id),
  employee_id INT REFERENCES employees(id),
  prize_label TEXT NOT NULL DEFAULT 'Торт или пирог «Мария»',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (year, month, kind)
);
