/**
 * Валидация URL вложений в мессенджере. Файлы грузятся ТОЛЬКО в наш Cloudinary
 * (unsigned preset), поэтому любой fileUrl/fileThumbnailUrl обязан быть
 * https://res.cloudinary.com/<нашего облака>/... Всё остальное — попытка
 * инъекции (stored XSS: URL раньше подставлялся в href/src/poster без экранирования)
 * или увода на чужой хост. Отклоняем на границе записи, чтобы грязь не попала в БД.
 */
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME ?? '';

/** true, если это валидный https-URL нашего Cloudinary. */
export function isAllowedAttachmentUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.hostname !== 'res.cloudinary.com') return false;
  // первый сегмент пути = имя облака. Без настроенного CLOUD — не пускаем ничего.
  if (!CLOUD) return false;
  const first = u.pathname.split('/').filter(Boolean)[0];
  return first === CLOUD;
}

/**
 * Нормализует пару (fileUrl, fileThumbnailUrl): оставляет только валидные наши
 * URL, невалидные → null. Возвращает {fileUrl, fileThumbnailUrl}. Если основной
 * fileUrl невалиден — обе выкидываются (вложения нет), бросать не нужно: текст
 * сообщения при этом сохранится.
 */
export function sanitizeAttachment(
  fileUrl?: string | null,
  fileThumbnailUrl?: string | null,
): { fileUrl: string | null; fileThumbnailUrl: string | null } {
  const url = isAllowedAttachmentUrl(fileUrl) ? (fileUrl as string) : null;
  const thumb = url && isAllowedAttachmentUrl(fileThumbnailUrl) ? (fileThumbnailUrl as string) : null;
  return { fileUrl: url, fileThumbnailUrl: thumb };
}
