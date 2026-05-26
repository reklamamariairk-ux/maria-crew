// Server-side upload в Cloudinary. Используется когда нужно сохранить
// файл, который не может попасть напрямую в браузер пользователя — например
// фото от сотрудника, пришедшее в Telegram-бот.
//
// Для героев и админских заливок используется unsigned upload с фронта.
// Здесь — POST с серверной стороны через тот же unsigned preset.

const CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME ?? '').trim();
const UPLOAD_PRESET = (process.env.CLOUDINARY_UPLOAD_PRESET ?? '').trim();

export interface UploadedImage {
  url: string;          // secure_url оригинала
  thumbnailUrl: string; // 300×300 cover preview
}

export function isCloudinaryConfigured(): boolean {
  return CLOUD_NAME.length > 0 && UPLOAD_PRESET.length > 0;
}

/** Загружает изображение в Cloudinary по URL (Cloudinary сам fetch'ит).
 *  Удобно для Telegram-файлов: даём URL вида
 *  https://api.telegram.org/file/bot<TOKEN>/<path> — Cloudinary
 *  скачивает, обрабатывает, отдаёт https-URL.
 *
 *  Возвращает оригинал + 300×300 cover-thumbnail (для превью в админке). */
export async function uploadImageFromUrl(sourceUrl: string): Promise<UploadedImage> {
  if (!isCloudinaryConfigured()) {
    throw new Error('Cloudinary не настроен (CLOUDINARY_CLOUD_NAME / CLOUDINARY_UPLOAD_PRESET)');
  }

  const form = new URLSearchParams();
  form.append('file', sourceUrl);
  form.append('upload_preset', UPLOAD_PRESET);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cloudinary upload failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { secure_url?: string; public_id?: string };
  if (!json.secure_url) {
    throw new Error('Cloudinary не вернул secure_url');
  }

  // Cloudinary URL transformations: вставляем `w_300,h_300,c_fill,q_auto`
  // после `/upload/`. Это даст 300×300 кропнутый превью без отдельного
  // запроса — генерится по требованию.
  const thumbnailUrl = json.secure_url.replace(
    /\/upload\//,
    '/upload/w_300,h_300,c_fill,q_auto/'
  );

  return { url: json.secure_url, thumbnailUrl };
}
