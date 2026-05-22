-- 044: Множественные товары 1С в одном призе.
--
-- Раньше приз мог быть привязан к одному товару (external_product_id).
-- Теперь — к массиву товаров (например приз «Торт + пирог» = 2 товара
-- разных кодов 1С). При одобрении заявки maria-crew вызовет /loyalty-gift
-- по одному на каждый item с externalRef = "<exchange_id>:<idx>".
--
-- Старые поля (external_product_id/name/qty) НЕ удаляем — оставляем для
-- back-compat в tryPushDelivery и для упрощения single-item case. При
-- любой записи через UI синхронизируем external_items с external_product_*
-- (items[0] copy в старые поля или NULL если items пустые).

ALTER TABLE prizes
  ADD COLUMN IF NOT EXISTS external_items JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Backfill: для призов с уже-привязанным single-item делаем external_items =
-- [{productId, name, qty}]. Только если external_items ещё пуст.
UPDATE prizes
   SET external_items = jsonb_build_array(
         jsonb_build_object(
           'productId', external_product_id,
           'name',      COALESCE(external_product_name, ''),
           'qty',       external_qty
         )
       )
 WHERE external_product_id IS NOT NULL
   AND external_product_id <> ''
   AND external_items = '[]'::jsonb;

-- Sanity: external_items должен быть массивом (не объект, не null).
ALTER TABLE prizes
  ADD CONSTRAINT prizes_external_items_is_array
    CHECK (jsonb_typeof(external_items) = 'array');
