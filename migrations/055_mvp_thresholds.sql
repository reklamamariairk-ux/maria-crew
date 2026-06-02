-- Пороги для тайного покупателя и чек-листа.
-- Выше порога — плюс к MVP score, ниже — минус (линейный штраф).
-- Дефолты: тайный 80%, чек-лист 70%.
ALTER TABLE mvp_config
  ADD COLUMN IF NOT EXISTS mystery_shopper_threshold NUMERIC(5,2) NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS checklist_threshold       NUMERIC(5,2) NOT NULL DEFAULT 70;

-- Тайного временно отключаем (вес 0) — у не всех сотрудников проходил визит,
-- но они выполнили план/чек-лист/отзывы. Когда тайный будет у всех — поднять.
UPDATE mvp_config SET mystery_shopper_weight = 0 WHERE id = 1;
