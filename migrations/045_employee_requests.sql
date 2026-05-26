-- 045: Запросы менеджеров к сотрудникам (текст + фото-ответ).
--
-- Use case: менеджер хочет проверить как сотрудник расположил товар.
-- Создаёт запрос в админке → бот шлёт DM сотруднику (или всем активным
-- сотрудникам точки) → сотрудник отвечает фото/текстом (reply на сообщение
-- бота) → ответ попадает в админку.
--
-- Связь ответ↔запрос — через telegram_message_id: бот запоминает какой
-- message_id отправил, и когда приходит reply_to_message с этим id —
-- знает к какому запросу относится ответ.

CREATE TABLE IF NOT EXISTS employee_requests (
  id                  SERIAL PRIMARY KEY,
  requested_by        INTEGER NOT NULL REFERENCES admin_users(id),
  target_employee_id  INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  target_store_id     INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  request_text        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','answered','closed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Адресат — либо конкретный сотрудник, либо вся точка (хотя бы что-то).
  CHECK (target_employee_id IS NOT NULL OR target_store_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_employee_requests_status_created
  ON employee_requests (status, created_at DESC);

-- Каждое отправленное сообщение бота: один request может породить несколько
-- notifications (если адресат — точка, шлём всем сотрудникам). По
-- telegram_message_id ловим reply на конкретного бот-сообщение.
CREATE TABLE IF NOT EXISTS request_notifications (
  id                   SERIAL PRIMARY KEY,
  request_id           INTEGER NOT NULL REFERENCES employee_requests(id) ON DELETE CASCADE,
  employee_id          INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  telegram_message_id  BIGINT NOT NULL,
  telegram_chat_id     BIGINT NOT NULL,
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Один сотрудник = одно сообщение на запрос (не дублируем).
  UNIQUE (request_id, employee_id)
);

-- Индекс для быстрого поиска при входящем reply (msg_id + chat_id уникальны в TG).
CREATE INDEX IF NOT EXISTS idx_request_notifications_lookup
  ON request_notifications (telegram_chat_id, telegram_message_id);

CREATE TABLE IF NOT EXISTS request_responses (
  id                   SERIAL PRIMARY KEY,
  request_id           INTEGER NOT NULL REFERENCES employee_requests(id) ON DELETE CASCADE,
  employee_id          INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  text_content         TEXT,
  photo_url            TEXT,    -- Cloudinary secure_url
  photo_thumbnail_url  TEXT,    -- Cloudinary transform для превью
  telegram_message_id  BIGINT,  -- id ответа сотрудника, для дедуплекации
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Хотя бы что-то должно быть — либо текст либо фото.
  CHECK (text_content IS NOT NULL OR photo_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_request_responses_request
  ON request_responses (request_id, created_at);
