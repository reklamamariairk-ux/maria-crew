-- Офисные операторы используют ту же модель сотрудников, Telegram, монет и VPN,
-- что и розница. workspace отделяет офисные команды от торговых точек.

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS workspace VARCHAR(10) NOT NULL DEFAULT 'retail';

ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_workspace_check;
ALTER TABLE stores
  ADD CONSTRAINT stores_workspace_check CHECK (workspace IN ('retail', 'office'));

CREATE INDEX IF NOT EXISTS idx_stores_workspace_active
  ON stores(workspace, is_active);

-- Стартовая команда нужна, чтобы сотрудника можно было сразу добавить по
-- Telegram username. Дополнительные команды можно будет завести позднее.
INSERT INTO stores(name, address, is_active, workspace)
SELECT 'Офис', 'Офисные операторы', true, 'office'
WHERE NOT EXISTS (SELECT 1 FROM stores WHERE workspace = 'office');
