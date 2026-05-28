-- 051: Отслеживание просмотра запроса каждым сотрудником-получателем.
--
-- Сейчас employee_requests.last_viewed_at — это для админа (badge unread
-- в админке). Для сотрудника-получателя нужно симметричное отслеживание:
-- каждый сотрудник видит свой набор unread-сообщений от менеджера.
--
-- Сотрудник открыл чат в приложении → INSERT/UPSERT в эту таблицу.
-- Badge на иконке «Сообщения» = SUM по всем его notifications где
-- есть свежие manager-сообщения после last_viewed_at.

CREATE TABLE IF NOT EXISTS request_employee_views (
  request_id     INTEGER NOT NULL REFERENCES employee_requests(id) ON DELETE CASCADE,
  employee_id    INTEGER NOT NULL REFERENCES employees(id)         ON DELETE CASCADE,
  last_viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_request_employee_views_employee
  ON request_employee_views (employee_id);
