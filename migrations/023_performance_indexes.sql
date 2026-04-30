-- Индексы для часто читаемых полей. Все CREATE INDEX IF NOT EXISTS — идемпотентны.

-- История монет: фильтр по сотруднику + сортировка по дате
CREATE INDEX IF NOT EXISTS idx_coin_transactions_emp_created
  ON coin_transactions(employee_id, created_at DESC);

-- Баланс карточек у сотрудника + статус «потрачена»
CREATE INDEX IF NOT EXISTS idx_employee_cards_emp_spent
  ON employee_cards(employee_id, is_spent);

-- Журнал админских действий: только сортировка по дате (мы листаем последние)
CREATE INDEX IF NOT EXISTS idx_audit_log_created
  ON admin_audit_log(created_at DESC);

-- Квиз-попытки: статистика и подбор последних 7 дней
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_emp_answered
  ON quiz_attempts(employee_id, answered_at);

-- Заявки на обмен: список pending, фильтр по сотруднику
CREATE INDEX IF NOT EXISTS idx_store_exchanges_status
  ON store_exchanges(status);
CREATE INDEX IF NOT EXISTS idx_store_exchanges_emp
  ON store_exchanges(employee_id);

-- Метрики месяца: чаще всего обращаемся по (store, year, month) и (employee, year, month)
CREATE INDEX IF NOT EXISTS idx_monthly_metrics_store_period
  ON monthly_metrics(store_id, year, month);
