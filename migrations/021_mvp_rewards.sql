-- Награды для MVP сотрудника и Топ-точки (настраиваются админом)

ALTER TABLE mvp_config
  ADD COLUMN IF NOT EXISTS mvp_coin_reward       INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS top_store_coin_reward INTEGER NOT NULL DEFAULT 30;
