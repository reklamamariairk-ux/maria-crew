-- Сезонные челленджи: награда монетами + ограничение по точкам.
-- coin_reward = 0 (default) — монеты не начисляются.
-- store_ids = NULL — челлендж доступен всем точкам (поведение как раньше).
-- store_ids = [] — недоступен никому (странно, но валидно).
-- store_ids = [1,2,5] — только этим точкам.

ALTER TABLE seasonal_challenges
  ADD COLUMN IF NOT EXISTS coin_reward INTEGER NOT NULL DEFAULT 0
    CHECK (coin_reward >= 0),
  ADD COLUMN IF NOT EXISTS store_ids INTEGER[];

-- Идемпотентность начисления монет: чтобы повторный вызов awardChallengeReward
-- не задвоил начисление. Карточка уже отслеживается через card_awarded.
ALTER TABLE seasonal_challenge_entries
  ADD COLUMN IF NOT EXISTS coins_awarded BOOLEAN NOT NULL DEFAULT false;
