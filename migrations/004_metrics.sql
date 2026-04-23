-- Ежемесячные показатели сотрудников и рейтинг точек

CREATE TABLE monthly_metrics (
  id                   SERIAL PRIMARY KEY,
  employee_id          INTEGER NOT NULL REFERENCES employees(id),
  store_id             INTEGER NOT NULL REFERENCES stores(id),
  year                 INTEGER NOT NULL,
  month                INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),

  -- Вводятся руководителем
  mystery_shopper_score  NUMERIC(5,2),           -- 0–100
  reviews_count          INTEGER NOT NULL DEFAULT 0,
  checklist_percent      NUMERIC(5,2),           -- 0–100
  revenue_percent        NUMERIC(6,2),           -- % от плана (102.5 = 102.5%)

  -- Рассчитываются автоматически
  -- mystery_shopper/100*30 + min(reviews*5,25) + checklist/100*25 + min(revenue/100*20,25)
  mvp_score              NUMERIC(6,2),
  is_mvp                 BOOLEAN NOT NULL DEFAULT false,

  -- JSON: [{hero_id, source, is_mvp}] — лог начисленных карточек
  cards_awarded          JSONB NOT NULL DEFAULT '[]',
  processed_at           TIMESTAMPTZ,            -- когда карточки фактически начислены

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (employee_id, year, month)
);

CREATE INDEX idx_metrics_store_period ON monthly_metrics(store_id, year, month);
CREATE INDEX idx_metrics_employee     ON monthly_metrics(employee_id);

-- Ежемесячный рейтинг точек (Топ-точка)
CREATE TABLE store_monthly_stats (
  id                   SERIAL PRIMARY KEY,
  store_id             INTEGER NOT NULL REFERENCES stores(id),
  year                 INTEGER NOT NULL,
  month                INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),

  -- Агрегаты по сотрудникам + ручной ввод рейтинга отзовиков
  avg_mystery_shopper  NUMERIC(5,2),
  avg_rating_score     NUMERIC(3,2),             -- рейтинг Яндекс/2ГИС/Google, вводится вручную
  avg_checklist        NUMERIC(5,2),
  revenue_percent      NUMERIC(6,2),

  -- avg_mystery/100*30 + avg_rating/5*25 + avg_checklist/100*25 + min(revenue/100*20,25)
  total_score          NUMERIC(6,2),
  rank                 INTEGER,                  -- место среди всех активных точек
  is_top               BOOLEAN NOT NULL DEFAULT false,

  processed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (store_id, year, month)
);

CREATE INDEX idx_store_stats_period ON store_monthly_stats(year, month);
