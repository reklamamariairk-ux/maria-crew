-- 042: Привязка призов к товарам 1С + поля статуса доставки в заявках.
--
-- Назначение: после одобрения заявки (approved) система делает HTTP-вызов
-- в 1С УПП для создания документа выдачи товара клиенту (сотруднику по его
-- телефону). Документ создаётся на товар по external_product_id × external_qty.
-- Идемпотентность обеспечивается externalRef = store_exchanges.id (1С
-- не должен создавать дубль при повторном вызове с тем же ref).
--
-- Поведение «без интеграции»: если у приза external_product_id IS NULL — это
-- обычный приз (сертификат/премия/торт-без-1с), и заявка обрабатывается
-- как раньше: руководитель сам отмечает fulfilled.

ALTER TABLE prizes
  ADD COLUMN IF NOT EXISTS external_product_id   TEXT,
  ADD COLUMN IF NOT EXISTS external_product_name TEXT,
  ADD COLUMN IF NOT EXISTS external_qty          INTEGER NOT NULL DEFAULT 1
    CHECK (external_qty > 0);

ALTER TABLE store_exchanges
  ADD COLUMN IF NOT EXISTS external_doc_id     TEXT,
  ADD COLUMN IF NOT EXISTS external_doc_status TEXT
    CHECK (external_doc_status IN ('pending','created','failed','mock_created')),
  ADD COLUMN IF NOT EXISTS external_doc_error  TEXT,
  ADD COLUMN IF NOT EXISTS external_doc_at     TIMESTAMPTZ;

-- Индекс для поиска failed-доставок (для retry-крон-задачи или ручной кнопки).
-- WHERE-условие делает индекс маленьким — только проблемные строки.
CREATE INDEX IF NOT EXISTS idx_exchanges_external_failed
  ON store_exchanges(external_doc_at)
  WHERE external_doc_status = 'failed';
