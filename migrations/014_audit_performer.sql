ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS performed_by TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_performer ON admin_audit_log(performed_by) WHERE performed_by IS NOT NULL;
