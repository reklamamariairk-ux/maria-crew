CREATE TABLE IF NOT EXISTS mvp_config (
  id                    SERIAL PRIMARY KEY,
  mystery_shopper_weight NUMERIC(5,2) NOT NULL DEFAULT 30,
  reviews_per_card       NUMERIC(5,2) NOT NULL DEFAULT 5,
  reviews_max            NUMERIC(5,2) NOT NULL DEFAULT 25,
  checklist_weight       NUMERIC(5,2) NOT NULL DEFAULT 25,
  revenue_weight_factor  NUMERIC(5,2) NOT NULL DEFAULT 20,
  revenue_max            NUMERIC(5,2) NOT NULL DEFAULT 25,
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO mvp_config
  (mystery_shopper_weight, reviews_per_card, reviews_max, checklist_weight, revenue_weight_factor, revenue_max)
VALUES (30, 5, 25, 25, 20, 25)
ON CONFLICT DO NOTHING;
