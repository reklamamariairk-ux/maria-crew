-- 052: Сотрудник тоже может начать диалог с руководителем (не только менеджер).
--
-- Раньше каждый thread создавал менеджер из админки, указывая получателей
-- (target_employee_id / target_store_id / request_targets). Теперь добавляем
-- симметрию: сотрудник в приложении нажимает «Написать руководителю» →
-- создаётся thread с initiated_by_employee_id = он сам, без target'ов.
-- Админы видят такие threads в общем списке «Мессенджер».

ALTER TABLE employee_requests
  ADD COLUMN IF NOT EXISTS initiated_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_employee_requests_initiated_by
  ON employee_requests (initiated_by_employee_id)
  WHERE initiated_by_employee_id IS NOT NULL;

-- requested_by был NOT NULL и ссылался на admin_users — для employee-initiated
-- запросов это поле пустое. Разрешаем NULL.
ALTER TABLE employee_requests ALTER COLUMN requested_by DROP NOT NULL;

-- Sanity-check: должен быть указан хотя бы один из создателей.
ALTER TABLE employee_requests
  ADD CONSTRAINT employee_requests_has_creator
    CHECK (requested_by IS NOT NULL OR initiated_by_employee_id IS NOT NULL);
