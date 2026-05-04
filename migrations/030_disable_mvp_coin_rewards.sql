-- Отключаем автоматическое начисление монет за «Лучший сотрудник» и «Лучшая точка».
-- Логика в rating.service.ts проверяет cfg.mvpCoinReward > 0 и cfg.topStoreCoinReward > 0 —
-- при 0 начисление пропускается. Карточки (особая со звездой и team_bonus) остаются.
--
-- Если потом захочется включить обратно — админка → Настройки → ввести нужные суммы.

UPDATE mvp_config
SET mvp_coin_reward       = 0,
    top_store_coin_reward = 0,
    updated_at            = NOW()
WHERE id = 1;
