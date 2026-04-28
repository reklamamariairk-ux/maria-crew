-- Лог действий администратора в админке.
-- Используется для отслеживания истории изменений: кто (пока без user-id,
-- т.к. админка работает с одним общим секретом) и что изменил.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          SERIAL PRIMARY KEY,
  action      VARCHAR(60) NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_action     ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON admin_audit_log(created_at DESC);
