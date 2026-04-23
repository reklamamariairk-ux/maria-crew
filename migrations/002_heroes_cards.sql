-- Герои и коллекция карточек

CREATE TABLE heroes (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  image_url   TEXT,
  is_limited  BOOLEAN NOT NULL DEFAULT false,  -- сезонные лимитки
  season      VARCHAR(10) CHECK (season IN ('summer', 'autumn', 'winter', 'spring')),
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- Источник начисления карточки
CREATE TYPE card_source AS ENUM (
  'mystery_shopper',  -- тайный покупатель >= 90
  'review',           -- именной отзыв гостя
  'checklist',        -- чек-лист 100% за месяц
  'plan',             -- план >= 105%
  'mvp',              -- MVP точки
  'team_bonus',       -- вся команда (Топ-точка)
  'seasonal',         -- сезонный челлендж
  'manual'            -- ручное начисление администратором
);

CREATE TABLE employee_cards (
  id          SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  hero_id     INTEGER NOT NULL REFERENCES heroes(id),
  is_mvp      BOOLEAN NOT NULL DEFAULT false,  -- особая карточка с отметкой MVP
  source      card_source NOT NULL,
  year        INTEGER NOT NULL,
  month       INTEGER NOT NULL,
  is_spent    BOOLEAN NOT NULL DEFAULT false,  -- списана при обмене в Store
  earned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cards_employee ON employee_cards(employee_id);
CREATE INDEX idx_cards_hero     ON employee_cards(hero_id);
