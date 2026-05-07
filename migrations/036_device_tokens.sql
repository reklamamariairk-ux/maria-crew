-- Регистр FCM/APNs токенов устройств для push-уведомлений мобильного приложения.
-- Один сотрудник может иметь несколько устройств (телефон + планшет).
-- При повторном входе с того же устройства — обновляем last_seen_at вместо вставки.

CREATE TABLE IF NOT EXISTS device_tokens (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  token        TEXT NOT NULL,
  platform     VARCHAR(16) NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  app_version  VARCHAR(32),
  device_model VARCHAR(64),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token)  -- один FCM-токен принадлежит ровно одному устройству глобально
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_employee ON device_tokens(employee_id);
