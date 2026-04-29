-- Обновление каталога призов Maria Store до версии 3.0
-- Старые призы деактивируются (история обменов сохраняется),
-- вместо них добавляются актуальные по документу v3.0.

-- Деактивируем весь старый каталог
UPDATE prizes SET is_active = false;

-- ── Призы за монеты ───────────────────────────────────────────────────────

INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT
  'Кофе в «Марии»',
  'Любой напиток в любой кондитерской «Мария»',
  'coffee', 0, 5, 10, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Кофе в «Марии»' AND is_active = true);

INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT
  'Пирожное на выбор',
  'Любое пирожное в любой кондитерской «Мария»',
  'coffee', 0, 8, 11, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Пирожное на выбор' AND is_active = true);

INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT
  'Пирожок или сэндвич + напиток',
  'Пирожок или сэндвич на выбор + любой напиток',
  'coffee', 0, 10, 12, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Пирожок или сэндвич + напиток' AND is_active = true);

INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT
  'Пирожное + кофе (комбо)',
  'Пирожное на выбор и любой кофе',
  'coffee', 0, 15, 13, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Пирожное + кофе (комбо)' AND is_active = true);

INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT
  'Торт или пирог «Мария»',
  'Торт или пирог «Мария» на выбор',
  'cake', 0, 30, 14, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Торт или пирог «Мария»' AND coins_required = 30 AND is_active = true);

INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT
  'Сертификат 2 000₽',
  'Ozon, Wildberries или кино — на выбор',
  'certificate', 0, 50, 15, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Сертификат 2 000₽' AND coins_required = 50 AND is_active = true);

-- ── Призы за карточки ─────────────────────────────────────────────────────

INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT
  'Торт или пирог «Мария» на выбор',
  'Любой торт или пирог «Мария» — за накопленные карточки',
  'cake', 3, 0, 20, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Торт или пирог «Мария» на выбор' AND is_active = true);

INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT
  'Сертификат 1 500₽',
  'Ozon, кино или кофейня — на выбор',
  'certificate', 5, 0, 21, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Сертификат 1 500₽' AND is_active = true);

INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT
  'Денежная премия 3 000₽',
  'Денежная премия к зарплате',
  'cash', 7, 0, 22, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Денежная премия 3 000₽' AND is_active = true);

INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT
  'Денежная премия 5 000₽',
  'Денежная премия к зарплате',
  'cash', 10, 0, 23, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Денежная премия 5 000₽' AND is_active = true);

INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT
  '«Золотой бейдж» + 7 000₽',
  'Легендарный статус за полную коллекцию + денежная премия',
  'golden_badge', 12, 0, 24, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = '«Золотой бейдж» + 7 000₽' AND is_active = true);
