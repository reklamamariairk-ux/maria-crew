-- Добавляем причины монет за выполнение/перевыполнение плана продаж.
-- В коде (src/types, src/services/coin.service.ts, admin/app.js, admin/index.html)
-- уже используются plan_100 и plan_105, но в enum coin_reason их не было —
-- INSERT в coin_transactions падал с "invalid input value for enum coin_reason".

ALTER TYPE coin_reason ADD VALUE IF NOT EXISTS 'plan_100';   -- ежедневное выполнение плана на 100% (+2)
ALTER TYPE coin_reason ADD VALUE IF NOT EXISTS 'plan_105';   -- ежедневное перевыполнение плана >105% (+5)
