-- Отдельное рабочее пространство для офисных операторов.
-- Розничные сотрудники остаются в employees/stores: данные двух контуров
-- физически разделены, чтобы офисная роль не могла случайно увидеть розницу.

ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_role_check;
ALTER TABLE admin_users
  ADD CONSTRAINT admin_users_role_check
  CHECK (role IN ('superadmin', 'editor', 'coin_admin', 'office_admin'));

CREATE TABLE office_teams (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE office_operators (
  id          SERIAL PRIMARY KEY,
  team_id     INTEGER REFERENCES office_teams(id),
  name        VARCHAR(100) NOT NULL,
  phone       VARCHAR(32),
  email       VARCHAR(254),
  joined_at   DATE,
  notes       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_office_operators_team_active
  ON office_operators(team_id, is_active);

-- Показатели задаются из интерфейса. target_value — план/норма,
-- weight — вклад показателя в итоговый балл, direction — что считается лучше.
CREATE TABLE office_metric_definitions (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(64) NOT NULL UNIQUE,
  name          VARCHAR(100) NOT NULL,
  unit          VARCHAR(24) NOT NULL DEFAULT '',
  target_value  NUMERIC(14, 2) NOT NULL CHECK (target_value >= 0),
  weight        NUMERIC(6, 2) NOT NULL DEFAULT 1 CHECK (weight >= 0 AND weight <= 100),
  direction     VARCHAR(10) NOT NULL DEFAULT 'higher'
                  CHECK (direction IN ('higher', 'lower')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE office_metric_values (
  operator_id   INTEGER NOT NULL REFERENCES office_operators(id) ON DELETE CASCADE,
  metric_id     INTEGER NOT NULL REFERENCES office_metric_definitions(id) ON DELETE CASCADE,
  year          INTEGER NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  month         INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  value         NUMERIC(14, 2) NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (operator_id, metric_id, year, month)
);

CREATE INDEX idx_office_metric_values_period
  ON office_metric_values(year, month, operator_id);
