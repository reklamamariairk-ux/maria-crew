-- Новые причины монет:
--   plan_dishes — выполнение плана по блюдам (+5, фиксированная)
--   drinks      — за напитки (баллы вручную, сумму вводит админ)

ALTER TYPE coin_reason ADD VALUE IF NOT EXISTS 'plan_dishes';   -- +5 фикс
ALTER TYPE coin_reason ADD VALUE IF NOT EXISTS 'drinks';        -- ручная сумма
