-- Сезонные челленджи (раз в квартал)

CREATE TABLE seasonal_challenges (
  id                    SERIAL PRIMARY KEY,
  name                  VARCHAR(100) NOT NULL,
  description           TEXT,
  season                VARCHAR(10) NOT NULL CHECK (season IN ('summer', 'autumn', 'winter', 'spring')),
  year                  INTEGER NOT NULL,
  hero_id               INTEGER REFERENCES heroes(id),  -- лимитная карточка-награда
  start_date            DATE NOT NULL,
  end_date              DATE NOT NULL,
  condition_description TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (season, year)
);
