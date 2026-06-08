-- Автоматическое начисление монет за выполнение плана по выручке при «Обработать месяц».
-- Начисляется КАЖДОМУ активному сотруднику точки по его revenue_percent в monthly_metrics,
-- как и монеты за отзывы (commitRewardsForStore). Идемпотентно по note.
--   plan_threshold        — % выполнения плана для базовой награды (def 100).
--   plan_coin_reward      — монет за достижение плана ≥ plan_threshold (def 15). 0 = выключено.
--   plan_over_threshold   — % строгого перевыполнения для повышенной награды (def 100).
--   plan_over_coin_reward — монет за перевыполнение > plan_over_threshold (def 20). 0 = выключено.
ALTER TABLE mvp_config
  ADD COLUMN IF NOT EXISTS plan_threshold        NUMERIC(5,2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS plan_coin_reward      INTEGER      NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS plan_over_threshold   NUMERIC(5,2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS plan_over_coin_reward INTEGER      NOT NULL DEFAULT 20;

-- За отзыв в 2ГИС теперь 10 монет (было 5).
UPDATE mvp_config SET review_coin_reward = 10 WHERE id = 1;
