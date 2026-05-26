// Server-side upload в Cloudinary. Используется когда нужно сохранить
// файл, который не может попасть напрямую в браузер пользователя — например
// фото от сотрудника, пришедшее в Telegram-бот.
//
// Для героев и админских заливок используется unsigned upload с фронта.
// Здесь — POST с серверной стороны через тот же unsigned preset.

const CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME ?? '').trim();
const UPLOAD_PRESET = (process.env.CLOUDINARY_UPLOAD_PRESET ?? '').trim();

export interface UploadedFile {
  url: string;                  // secure_url оригинала
  thumbnailUrl: string | null;  // только для image/video; для document null
}

export type CloudinaryResource = 'image' | 'video' | 'raw';

export function isCloudinaryConfigured(): boolean {
  return CLOUD_NAME.length > 0 && UPLOAD_PRESET.length > 0;
}

/** Загружает файл в Cloudinary по URL (Cloudinary сам fetch'ит).
 *  Удобно для Telegram-файлов.
 *  - image: возвращает 300×300 cover-thumbnail.
 *  - video: возвращает кадр в 300×300 (через `c_fill,so_0`) как thumbnail.
 *  - raw (документы): thumbnail = null. */
export async function uploadFileFromUrl(
  sourceUrl: string,
  resource: CloudinaryResource = 'image'
): Promise<UploadedFile> {
  if (!isCloudinaryConfigured()) {
    throw new Error('Cloudinary не настроен (CLOUDINARY_CLOUD_NAME / CLOUDINARY_UPLOAD_PRESET)');
  }

  const form = new URLSearchParams();
  form.append('file', sourceUrl);
  form.append('upload_preset', UPLOAD_PRESET);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${resource}/upload`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cloudinary ${resource} upload failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { secure_url?: string; public_id?: string };
  if (!json.secure_url) {
    throw new Error('Cloudinary не вернул secure_url');
  }

  let thumbnailUrl: string | null = null;
  if (resource === 'image') {
    thumbnailUrl = json.secure_url.replace(
      /\/upload\//,
      '/upload/w_300,h_300,c_fill,q_auto/'
    );
  } else if (resource === 'video') {
    // Кадр 0 как jpg-thumbnail. Cloudinary auto-transforms к .jpg.
    thumbnailUrl = json.secure_url.replace(
      /\/upload\//,
      '/upload/w_300,h_300,c_fill,so_0/'
    ).replace(/\.(mp4|mov|avi|webm|mkv)$/i, '.jpg');
  }

  return { url: json.secure_url, thumbnailUrl };
}

/** Back-compat alias для существующих вызовов (только image). */
export async function uploadImageFromUrl(sourceUrl: string): Promise<UploadedFile> {
  return uploadFileFromUrl(sourceUrl, 'image');
}
