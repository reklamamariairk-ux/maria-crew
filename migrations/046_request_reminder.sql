-- 046: Напоминание сотруднику если он не ответил на запрос за 2 часа.
--
-- Без этой колонки cron не сможет отличить «уже напомнил» от «надо
-- напомнить». Напоминание шлём один раз — если и через 2 часа после
-- него нет ответа, дальше следит руководитель через админку.

ALTER TABLE request_notifications
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- Индекс для cron-запроса (ищем outstanding без напоминания).
CREATE INDEX IF NOT EXISTS idx_request_notifications_no_reminder
  ON request_notifications (sent_at)
  WHERE reminder_sent_at IS NULL;
