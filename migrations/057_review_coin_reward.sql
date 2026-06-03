-- Автоматическое начисление монет за каждый отзыв при «Обработать месяц».
-- 0 = выключено (если задавать руками в табе Монеты).
ALTER TABLE mvp_config
  ADD COLUMN IF NOT EXISTS review_coin_reward INTEGER NOT NULL DEFAULT 5;

-- MVP-монеты убираем по запросу пользователя — MVP получает только карточку.
UPDATE mvp_config SET mvp_coin_reward = 0 WHERE id = 1;
