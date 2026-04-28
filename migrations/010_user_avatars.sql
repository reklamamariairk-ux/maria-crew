-- Telegram-аватарка и время последнего входа сотрудника

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS telegram_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_employees_last_seen_at ON employees(last_seen_at DESC);
