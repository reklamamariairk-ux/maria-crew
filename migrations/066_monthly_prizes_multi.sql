-- «Торт месяца»: разрешаем НЕСКОЛЬКО сотрудников-победителей в месяце
-- (авто-лучший + добавленные админом вручную). Дубли конкретного человека/точки
-- в месяце по-прежнему невозможны (уникальный индекс с COALESCE — NULLы в
-- postgres иначе считаются различными).
ALTER TABLE monthly_prizes DROP CONSTRAINT IF EXISTS monthly_prizes_year_month_kind_key;
CREATE UNIQUE INDEX IF NOT EXISTS monthly_prizes_uniq
  ON monthly_prizes (year, month, kind, COALESCE(employee_id, 0), COALESCE(store_id, 0));
