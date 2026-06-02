-- 054: Удаление приза «в любом случае» без потери истории обменов.
--
-- Раньше DELETE /prizes/:id блокировался при наличии заявок: store_exchanges
-- ссылается на prizes через NOT NULL FK с RESTRICT. Чтобы приз можно было
-- удалить всегда, сохраняя историю обменов:
--   1) снапшотим название и тип приза прямо в store_exchanges,
--   2) делаем prize_id NULLable и меняем FK на ON DELETE SET NULL.
-- Тогда удаление приза просто отвязывает заявки (prize_id → NULL), а имя/тип
-- остаются в снапшоте — списки заявок и уведомления не ломаются
-- (читатели берут COALESCE(p.name, se.prize_name)).

ALTER TABLE store_exchanges
  ADD COLUMN IF NOT EXISTS prize_name TEXT,
  ADD COLUMN IF NOT EXISTS prize_type TEXT;

-- Бэкфилл снапшота для уже существующих заявок.
UPDATE store_exchanges se
SET prize_name = p.name,
    prize_type = p.prize_type
FROM prizes p
WHERE p.id = se.prize_id
  AND se.prize_name IS NULL;

-- prize_id больше не обязателен (после удаления приза станет NULL).
ALTER TABLE store_exchanges ALTER COLUMN prize_id DROP NOT NULL;

-- Меняем поведение FK на ON DELETE SET NULL.
ALTER TABLE store_exchanges DROP CONSTRAINT IF EXISTS store_exchanges_prize_id_fkey;
ALTER TABLE store_exchanges
  ADD CONSTRAINT store_exchanges_prize_id_fkey
  FOREIGN KEY (prize_id) REFERENCES prizes(id) ON DELETE SET NULL;
