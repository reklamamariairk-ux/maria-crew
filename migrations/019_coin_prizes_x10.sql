-- Увеличение стоимости призов за монеты в 10 раз

UPDATE prizes SET coins_required = 50  WHERE name = 'Кофе в «Марии»'               AND coins_required > 0;
UPDATE prizes SET coins_required = 80  WHERE name = 'Пирожное на выбор'             AND coins_required > 0;
UPDATE prizes SET coins_required = 100 WHERE name = 'Пирожок или сэндвич + напиток' AND coins_required > 0;
UPDATE prizes SET coins_required = 150 WHERE name = 'Пирожное + кофе (комбо)'       AND coins_required > 0;
UPDATE prizes SET coins_required = 300 WHERE name = 'Торт или пирог «Мария»'        AND coins_required > 0 AND cards_required = 0;
UPDATE prizes SET coins_required = 500 WHERE name = 'Сертификат 2 000₽'             AND coins_required > 0;
