-- Пороги выдачи карточек (раньше были хардкодом в card.service.ts).
-- Карточка выдаётся когда метрика >= порог. Лимит отзывов — сколько карточек
-- максимум за отзывы (с учётом «по 1 за каждый отзыв» в calcCardAwards).
ALTER TABLE mvp_config
  ADD COLUMN IF NOT EXISTS card_threshold_mystery_shopper NUMERIC(5,2) NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS card_threshold_checklist       NUMERIC(5,2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS card_threshold_revenue         NUMERIC(5,2) NOT NULL DEFAULT 105,
  ADD COLUMN IF NOT EXISTS card_max_reviews_count         INTEGER      NOT NULL DEFAULT 2;
