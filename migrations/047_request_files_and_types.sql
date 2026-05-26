-- 047: Поддержка видео и документов в ответах сотрудников + обобщение
-- колонок (photo_* → file_*) с подвиду в файле.
--
-- Раньше можно было прислать только фото. Теперь принимаем также видео
-- (max 50MB по умолчанию в TG) и любые документы. Cloudinary поддерживает
-- raw/upload для произвольных файлов; видео через video/upload c автoframe.
--
-- Старые photo_* колонки оставлены для безопасного отката; backfill копирует
-- их в file_* и помечает file_type='photo'.

ALTER TABLE request_responses
  ADD COLUMN IF NOT EXISTS file_url            TEXT,
  ADD COLUMN IF NOT EXISTS file_thumbnail_url  TEXT,
  ADD COLUMN IF NOT EXISTS file_type           TEXT
    CHECK (file_type IS NULL OR file_type IN ('photo','video','document')),
  ADD COLUMN IF NOT EXISTS file_name           TEXT;

-- Backfill: всё что было в photo_url — это photo.
UPDATE request_responses
   SET file_url           = photo_url,
       file_thumbnail_url = photo_thumbnail_url,
       file_type          = 'photo'
 WHERE photo_url IS NOT NULL AND file_url IS NULL;

-- Обновляем CHECK: ответ должен содержать либо текст, либо файл (любого типа).
-- Старый check был "text_content IS NOT NULL OR photo_url IS NOT NULL" — найдём
-- по pg_constraint и заменим. Имя generic CHECK constraint у Postgres
-- предсказуемое — обычно <table>_<col>_check, но мы добавляли inline
-- "OR photo_url IS NOT NULL", постгрес назвал constraint автоматически.
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
    FROM pg_constraint
   WHERE conrelid = 'request_responses'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%photo_url IS NOT NULL%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE request_responses DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE request_responses
  ADD CONSTRAINT request_responses_has_content
    CHECK (text_content IS NOT NULL OR file_url IS NOT NULL);
