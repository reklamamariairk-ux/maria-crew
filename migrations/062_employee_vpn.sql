-- Связь сотрудника crew с VPN-юзером vpn-panel (users.json на том же VPS).
-- crew — источник правды по людям, vpn-panel — по ключам/портам.
CREATE TABLE employee_vpn (
  employee_id INTEGER NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  vpn_name    TEXT    NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
