-- 043: Локальный кэш Номенклатуры 1С УПП.
--
-- Цель — быстрый autocomplete по коду/названию товара в админке (привязка
-- к призу). Hostinger VPS не в whitelist 1С, ходим через прокси
-- sales-dashboard. Кэш обновляется раз в день кроном + кнопкой вручную.
--
-- Источник данных: GET /products-detail на ДашбордПродажАПИ (через
-- прокси sales-dashboard /api/upp/proxy/products-detail).

CREATE TABLE IF NOT EXISTS one_c_nomenclature_cache (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  group_name  TEXT,
  unit        TEXT,
  unit_ratio  NUMERIC,
  weight      NUMERIC,
  kind        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Индекс на name для ILIKE-поиска (CITEXT не используем чтобы не лочить
-- расширение в БД). gin_trgm дал бы лучшее качество — но pg_trgm нужно
-- enable, а для autocomplete на 10-15k строк хватит и ILIKE с лимитом.
CREATE INDEX IF NOT EXISTS idx_nomenclature_name_lower
  ON one_c_nomenclature_cache (lower(name));

-- Метаданные последнего refresh — одна запись.
CREATE TABLE IF NOT EXISTS one_c_catalog_meta (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_refresh_at TIMESTAMPTZ,
  last_refresh_count INTEGER,
  last_refresh_error TEXT
);
INSERT INTO one_c_catalog_meta (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;
