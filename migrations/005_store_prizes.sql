-- Maria Store: каталог призов и история обменов

CREATE TYPE prize_type AS ENUM (
  'cake',          -- торт/пирог «Мария»
  'certificate',   -- сертификат (Ozon / кино / кофейня)
  'cash',          -- денежная премия
  'shift_choice',  -- выбор смен на следующий месяц
  'golden_badge',  -- «Золотой бейдж» + выходной
  'coffee',        -- кофе + десерт
  'discount',      -- скидка на торт на заказ
  'merch',         -- мерч Maria Crew
  'break'          -- дополнительный перерыв
);

CREATE TABLE prizes (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(200) NOT NULL,
  description     TEXT,
  prize_type      prize_type NOT NULL,
  cards_required  INTEGER NOT NULL DEFAULT 0,
  coins_required  INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE TYPE exchange_status AS ENUM ('pending', 'approved', 'rejected', 'fulfilled');

CREATE TABLE store_exchanges (
  id            SERIAL PRIMARY KEY,
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  prize_id      INTEGER NOT NULL REFERENCES prizes(id),
  cards_spent   INTEGER NOT NULL DEFAULT 0,
  coins_spent   INTEGER NOT NULL DEFAULT 0,
  card_ids      INTEGER[],           -- ID конкретных карточек из employee_cards
  status        exchange_status NOT NULL DEFAULT 'pending',
  notes         TEXT,
  processed_by  INTEGER REFERENCES employees(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);

CREATE INDEX idx_exchanges_employee ON store_exchanges(employee_id);
CREATE INDEX idx_exchanges_status   ON store_exchanges(status);
