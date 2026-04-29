-- Многопользовательская админка с ролями
-- Роли:
--   superadmin   — полный доступ + управление другими админами + настройки
--   editor       — всё кроме операций с монетами
--   coin_admin   — только начисление/списание монет

CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(64) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(20) NOT NULL CHECK (role IN ('superadmin', 'editor', 'coin_admin')),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);
