-- Один профиль сотрудника может одновременно оставаться на своей торговой
-- точке и быть выбранным в офисный контур. Telegram, монеты и VPN при этом
-- не дублируются: офис хранит только ссылку на существующего employees.

CREATE TABLE IF NOT EXISTS office_employee_memberships (
  employee_id    INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  office_store_id INTEGER NOT NULL REFERENCES stores(id),
  added_by       INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_office_employee_memberships_store
  ON office_employee_memberships(office_store_id);

ALTER TABLE office_employee_memberships DROP CONSTRAINT IF EXISTS office_membership_store_workspace_check;
ALTER TABLE office_employee_memberships
  ADD CONSTRAINT office_membership_store_workspace_check
  CHECK (office_store_id > 0);
