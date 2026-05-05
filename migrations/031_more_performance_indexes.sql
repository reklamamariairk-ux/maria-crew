-- Дополнительные индексы для перформанса.

-- COUNT DISTINCT hero_id в getStats (Mini App шапка) — JOIN heroes по hero_id
-- + фильтр по employee_id. Композитный индекс ускорит и DISTINCT, и JOIN.
CREATE INDEX IF NOT EXISTS idx_employee_cards_emp_hero
  ON employee_cards(employee_id, hero_id);

-- monthly_metrics для individual lookup сотрудника + всех его периодов
-- (используется в leaderboard, dashboard, detail-эндпоинтах)
CREATE INDEX IF NOT EXISTS idx_monthly_metrics_emp_period
  ON monthly_metrics(employee_id, year, month);

-- store_monthly_stats для getStoreLeaderboard (фильтр по периоду)
CREATE INDEX IF NOT EXISTS idx_store_monthly_stats_period
  ON store_monthly_stats(year, month);

-- exchange status + дата для digestPendingExchanges (заявки старше 24ч)
CREATE INDEX IF NOT EXISTS idx_store_exchanges_status_created
  ON store_exchanges(status, created_at);

-- coin_transactions reason — для запросов «у кого нет начисления X сегодня»
-- (используется в remindDailyCoins) и в аналитике CSV-экспорта по причине
CREATE INDEX IF NOT EXISTS idx_coin_transactions_reason_created
  ON coin_transactions(reason, created_at DESC);
