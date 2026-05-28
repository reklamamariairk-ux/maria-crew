-- 049: Chat-mode в запросах + badge unread-count.
--
-- Раньше запрос был «one-shot»: менеджер написал → сотрудник ответил →
-- single-employee запрос auto-close в 'answered'. Если менеджеру надо
-- уточнить — он создавал новый запрос. Это плохой UX для диалога.
--
-- Теперь request — это thread: менеджер пишет в существующий запрос,
-- сотрудник отвечает. Сообщения в одной таблице с типом отправителя.
-- Auto-close убираем — статус 'open' пока менеджер вручную не закроет.

-- sender_type у каждого сообщения. NULL для legacy записей = 'employee'.
ALTER TABLE request_responses
  ADD COLUMN IF NOT EXISTS sender_type TEXT
    CHECK (sender_type IS NULL OR sender_type IN ('employee', 'manager'));

UPDATE request_responses SET sender_type = 'employee' WHERE sender_type IS NULL;
ALTER TABLE request_responses
  ALTER COLUMN sender_type SET DEFAULT 'employee',
  ALTER COLUMN sender_type SET NOT NULL;

-- last_viewed_at — для badge unread-count. NULL = не смотрел.
-- При POST /api/requests/:id/message и GET /api/requests/:id обновляется.
ALTER TABLE employee_requests
  ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ;

-- Поскольку chat-mode заменяет auto-close, переводим существующие 'answered'
-- обратно в 'open' чтобы менеджер мог продолжить диалог.
UPDATE employee_requests SET status = 'open' WHERE status = 'answered';
