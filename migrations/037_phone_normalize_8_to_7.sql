-- Перенормализация phone_normalized: «8XXXXXXXXXX» → «7XXXXXXXXXX».
-- Российские номера могут быть введены и с +7, и с 8 — это один номер.
-- При первой заливке в 035 мы только убирали нецифры, поэтому в БД лежит
-- смесь: у одних 79991234567, у других 89991234567. После этого фикса
-- все будут в формате 7XXXXXXXXXX, и normalizePhone() в коде делает то же самое
-- с пользовательским вводом — так что match всегда корректный.

UPDATE employees
SET phone_normalized = '7' || SUBSTRING(phone_normalized FROM 2)
WHERE phone_normalized IS NOT NULL
  AND LENGTH(phone_normalized) = 11
  AND phone_normalized LIKE '8%';
