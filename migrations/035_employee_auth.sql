-- Авторизация сотрудников для мобильного приложения.
-- Логин по телефону + одноразовый PIN, который отправляется в Telegram-чат бота.
-- JWT-токен на 30 дней. Никаких паролей — пользователь ничего не запоминает,
-- сброса нет, безопаснее (PIN живёт 10 минут).

-- Нормализованный телефон (только цифры) — для быстрого поиска и сравнения.
-- Существующее поле phone остаётся как «как ввели», новое поле — для индекса.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(32);

-- Backfill: убираем все нецифровые символы из существующих телефонов.
UPDATE employees
SET phone_normalized = REGEXP_REPLACE(phone, '[^0-9]', '', 'g')
WHERE phone IS NOT NULL AND phone_normalized IS NULL;

CREATE INDEX IF NOT EXISTS idx_employees_phone_normalized ON employees(phone_normalized);

-- Одноразовые PIN-коды для входа. Хранится только хеш (scrypt), как у админа.
CREATE TABLE IF NOT EXISTS auth_pins (
  id          SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  pin_hash    TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_pins_employee ON auth_pins(employee_id);
CREATE INDEX IF NOT EXISTS idx_auth_pins_expires  ON auth_pins(expires_at);
