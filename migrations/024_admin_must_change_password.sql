-- Флаг «требуется смена пароля» для админов.
-- Устанавливается суперадмином при сбросе пароля; снимается при первой успешной смене.

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
