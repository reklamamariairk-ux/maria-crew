-- Пороги назначения MVP/топ-точки и метрика «Аттестация»
-- mvpMinScore — MVP не назначается если max score ≤ порога (def 80).
-- topStoreMinScore — топ-точка не назначается если max storeScore ≤ порога (def 70).
-- cardThresholdCertification — порог выдачи карточки «certification» (def 80).
ALTER TABLE mvp_config
  ADD COLUMN IF NOT EXISTS mvp_min_score                NUMERIC(5,2) NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS top_store_min_score          NUMERIC(5,2) NOT NULL DEFAULT 70,
  ADD COLUMN IF NOT EXISTS card_threshold_certification NUMERIC(5,2) NOT NULL DEFAULT 80;

-- Аттестация — новая метрика сотрудника (0-100).
ALTER TABLE monthly_metrics
  ADD COLUMN IF NOT EXISTS attestation_percent NUMERIC(5,2);

COMMENT ON COLUMN employee_cards.source IS
  'mystery_shopper | review | checklist | plan | mvp | team_bonus | certification | seasonal | manual';
