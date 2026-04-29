-- Maria Crew v3.0: новые причины монет + источник карточки "аттестация"

-- Новые положительные причины начисления монет
ALTER TYPE coin_reason ADD VALUE IF NOT EXISTS 'training_meeting';   -- участие в собрании по обучению
ALTER TYPE coin_reason ADD VALUE IF NOT EXISTS 'knowledge_applied';  -- тренер подтвердил применение знаний

-- Новые причины списания монет
ALTER TYPE coin_reason ADD VALUE IF NOT EXISTS 'bad_review';         -- отрицательный отзыв гостя
ALTER TYPE coin_reason ADD VALUE IF NOT EXISTS 'dirty_store';        -- не пройден чек-лист / грязно
ALTER TYPE coin_reason ADD VALUE IF NOT EXISTS 'training_resistance';-- сопротивление обучению

-- Новый источник карточки: аттестация
ALTER TYPE card_source ADD VALUE IF NOT EXISTS 'certification';
