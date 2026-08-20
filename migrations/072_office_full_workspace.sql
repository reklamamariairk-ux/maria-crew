-- Полный офисный интерфейс: отдельные сообщения, метрики и месячные призы.

ALTER TABLE employee_requests
  ADD COLUMN IF NOT EXISTS workspace VARCHAR(10) NOT NULL DEFAULT 'retail';
ALTER TABLE employee_requests DROP CONSTRAINT IF EXISTS employee_requests_workspace_check;
ALTER TABLE employee_requests ADD CONSTRAINT employee_requests_workspace_check
  CHECK (workspace IN ('retail', 'office'));
CREATE INDEX IF NOT EXISTS idx_employee_requests_workspace_status
  ON employee_requests(workspace, status, updated_at DESC);

ALTER TABLE monthly_metrics
  ADD COLUMN IF NOT EXISTS workspace VARCHAR(10) NOT NULL DEFAULT 'retail';
ALTER TABLE monthly_metrics DROP CONSTRAINT IF EXISTS monthly_metrics_workspace_check;
ALTER TABLE monthly_metrics ADD CONSTRAINT monthly_metrics_workspace_check
  CHECK (workspace IN ('retail', 'office'));
ALTER TABLE monthly_metrics DROP CONSTRAINT IF EXISTS monthly_metrics_employee_id_year_month_key;
CREATE UNIQUE INDEX IF NOT EXISTS monthly_metrics_employee_period_workspace_key
  ON monthly_metrics(employee_id, year, month, workspace);
CREATE INDEX IF NOT EXISTS idx_monthly_metrics_workspace_period
  ON monthly_metrics(workspace, year, month, store_id);

ALTER TABLE monthly_prizes
  ADD COLUMN IF NOT EXISTS workspace VARCHAR(10) NOT NULL DEFAULT 'retail';
ALTER TABLE monthly_prizes DROP CONSTRAINT IF EXISTS monthly_prizes_workspace_check;
ALTER TABLE monthly_prizes ADD CONSTRAINT monthly_prizes_workspace_check
  CHECK (workspace IN ('retail', 'office'));
DROP INDEX IF EXISTS monthly_prizes_uniq;
CREATE UNIQUE INDEX monthly_prizes_uniq
  ON monthly_prizes (workspace, year, month, kind, COALESCE(employee_id, 0), COALESCE(store_id, 0));
CREATE INDEX IF NOT EXISTS idx_monthly_prizes_workspace_period
  ON monthly_prizes(workspace, year, month);

ALTER TABLE seasonal_challenges
  ADD COLUMN IF NOT EXISTS workspace VARCHAR(10) NOT NULL DEFAULT 'retail';
ALTER TABLE seasonal_challenges DROP CONSTRAINT IF EXISTS seasonal_challenges_workspace_check;
ALTER TABLE seasonal_challenges ADD CONSTRAINT seasonal_challenges_workspace_check
  CHECK (workspace IN ('retail', 'office'));
CREATE INDEX IF NOT EXISTS idx_seasonal_challenges_workspace_active
  ON seasonal_challenges(workspace, is_active, start_date, end_date);
