-- Гарантирует, что в каталоге есть все призы за монеты.
-- На случай если seed запускался на пустой БД до того, как coin-призы
-- были добавлены в код — без этой миграции в магазине будут только карточки.

INSERT INTO prizes (name, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT 'Кофе + десерт в «Марии»', 'coffee', 0, 10, 10, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Кофе + десерт в «Марии»');

INSERT INTO prizes (name, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT 'Скидка 30% на торт на заказ', 'discount', 0, 20, 11, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Скидка 30% на торт на заказ');

INSERT INTO prizes (name, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT 'Мерч Maria Crew', 'merch', 0, 30, 12, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Мерч Maria Crew');

INSERT INTO prizes (name, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT 'Сертификат 2 000₽ (Ozon/WB)', 'certificate', 0, 50, 13, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Сертификат 2 000₽ (Ozon/WB)');

INSERT INTO prizes (name, prize_type, cards_required, coins_required, sort_order, is_active)
SELECT 'Доп. перерыв 15 мин.', 'break', 0, 15, 14, true
WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE name = 'Доп. перерыв 15 мин.');
