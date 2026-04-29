-- Номер телефона сотрудника
-- Заполняется через бота (message.contact), webapp (requestContact()) или вручную в админке.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_employees_phone ON employees(phone);
