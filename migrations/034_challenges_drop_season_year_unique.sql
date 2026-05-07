-- Снимаем UNIQUE (season, year) на seasonal_challenges.
--
-- Старая логика: один челлендж на сезон (создан в 006_seasonal_challenges.sql).
-- После миграции 033 челленджи можно ограничивать списком точек, поэтому
-- в одном сезоне могут существовать несколько параллельных — например, для
-- разных групп точек, или разные уровни сложности.
--
-- Имя ограничения по умолчанию: seasonal_challenges_season_year_key.
-- IF EXISTS — на случай повторного применения.

ALTER TABLE seasonal_challenges
  DROP CONSTRAINT IF EXISTS seasonal_challenges_season_year_key;
