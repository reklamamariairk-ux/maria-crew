-- 053: Категории призов (меню магазина).
--
-- Гибкая замена жёсткому ENUM prize_type для ГРУППИРОВКИ призов в витрине
-- Mini App. prize_type остаётся как есть (иконка позиции + back-compat),
-- а группировку/секции меню ведёт категория (у неё свой emoji и порядок).
-- Категориями управляет админ (CRUD + порядок) без новых миграций.

CREATE TABLE IF NOT EXISTS prize_categories (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  emoji       VARCHAR(16),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE prizes
  ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES prize_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_prizes_category ON prizes (category_id);

-- Стартовый набор категорий — только если таблица ещё пустая (идемпотентно).
INSERT INTO prize_categories (name, emoji, sort_order)
SELECT v.name, v.emoji, v.sort_order
FROM (VALUES
  ('Напитки и кофе', '☕', 10),
  ('Торты и выпечка', '🎂', 20),
  ('Десерты',         '🍰', 30),
  ('Мерч',            '🎁', 40),
  ('Сертификаты',     '🎫', 50),
  ('Премии',          '💵', 60),
  ('Привилегии',      '🎉', 70)
) AS v(name, emoji, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM prize_categories);

-- Бэкфилл: раскладываем существующие призы по категориям из prize_type.
-- Только те, у кого категория ещё не проставлена.
UPDATE prizes p SET category_id = c.id
FROM prize_categories c
WHERE p.category_id IS NULL AND (
  (p.prize_type = 'coffee'      AND c.name = 'Напитки и кофе')  OR
  (p.prize_type = 'cake'        AND c.name = 'Торты и выпечка') OR
  (p.prize_type = 'merch'       AND c.name = 'Мерч')            OR
  (p.prize_type = 'certificate' AND c.name = 'Сертификаты')     OR
  (p.prize_type = 'cash'        AND c.name = 'Премии')          OR
  (p.prize_type IN ('shift_choice','golden_badge','break','discount') AND c.name = 'Привилегии')
);
