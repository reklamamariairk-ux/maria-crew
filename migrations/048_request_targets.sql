-- 048: Произвольный набор получателей запроса (multi-select).
--
-- Раньше адресат был либо один сотрудник, либо вся точка. Теперь — любой
-- набор сотрудников (например 3 из 5 на точке, или сборная из двух точек).
-- Для этого junction-таблица request_targets.
--
-- Старые колонки target_employee_id / target_store_id оставлены для
-- удобства отображения (если 1 target — показываем как single-employee,
-- если все из одной точки — показываем как store). Backfill: для существующих
-- single-target создаём 1 запись, для store-target — N записей по активным
-- сотрудникам точки на момент миграции.

CREATE TABLE IF NOT EXISTS request_targets (
  request_id  INTEGER NOT NULL REFERENCES employee_requests(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id)        ON DELETE CASCADE,
  PRIMARY KEY (request_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_request_targets_employee
  ON request_targets (employee_id);

-- Backfill single-employee запросов.
INSERT INTO request_targets (request_id, employee_id)
  SELECT id, target_employee_id
  FROM employee_requests
  WHERE target_employee_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Backfill store-запросов: все активные сотрудники точки на текущий момент.
INSERT INTO request_targets (request_id, employee_id)
  SELECT r.id, e.id
  FROM employee_requests r
  JOIN employees e ON e.store_id = r.target_store_id AND e.is_active = true
  WHERE r.target_store_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Снимаем старый CHECK (target_employee_id OR target_store_id) — теперь оба
-- могут быть NULL когда выбор произвольный (multi-select из разных точек).
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
    FROM pg_constraint
   WHERE conrelid = 'employee_requests'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%target_employee_id IS NOT NULL%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE employee_requests DROP CONSTRAINT %I', c_name);
  END IF;
END $$;
