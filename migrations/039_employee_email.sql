-- Email сотрудника — для отправки PIN-кодов входа в мобильное приложение
-- (как альтернатива Telegram-боту). Установка по желанию.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS email VARCHAR(120);

-- Уникальность email — case-insensitive, только для NOT NULL значений.
-- Двое сотрудников не могут иметь одинаковый email, но иметь NULL могут все.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email_unique
  ON employees(LOWER(email)) WHERE email IS NOT NULL;
