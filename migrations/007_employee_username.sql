-- Добавляем Telegram username для поиска сотрудника при первом /start
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS telegram_username VARCHAR(64) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_employees_telegram_username ON employees(telegram_username);
