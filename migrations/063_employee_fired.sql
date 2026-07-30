-- Увольнение сотрудников: fired_at != NULL — уволен (VPN отозван, вход закрыт,
-- в админке живёт во вкладке «Уволенные»). Возврат в компанию обнуляет поле.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS fired_at TIMESTAMPTZ;
