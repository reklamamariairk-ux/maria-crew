-- История уведомлений сотрудника. До этого уведомления только улетали в Telegram
-- и push, не сохранялись — в приложении нельзя было посмотреть «что мне писали».
--
-- Заполняется автоматически из notifyCoinAward / notifyCardAward / notifyExchangeStatus
-- и т.д. Пользователь видит ленту в колокольчике 🔔, может пометить прочитанным.

CREATE TABLE IF NOT EXISTS notifications (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type         VARCHAR(32) NOT NULL,    -- coin_award | card_award | exchange | challenge | system
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  data         JSONB,                   -- произвольные key-value (amount, reason, refs)
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Частый запрос: «посчитать непрочитанные у этого сотрудника»
CREATE INDEX IF NOT EXISTS idx_notifications_employee_unread
  ON notifications(employee_id) WHERE read_at IS NULL;

-- Лента: «последние N для сотрудника, отсортированные»
CREATE INDEX IF NOT EXISTS idx_notifications_employee_created
  ON notifications(employee_id, created_at DESC);
