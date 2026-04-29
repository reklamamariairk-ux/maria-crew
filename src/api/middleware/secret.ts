import crypto from 'crypto';

// Если ADMIN_SECRET не задан в env, деривируем его из BOT_TOKEN.
// Используется для подписи токенов и bootstrap-пароля superadmin.
function getEffectiveSecret(): string {
  if (process.env.ADMIN_SECRET) return process.env.ADMIN_SECRET;
  const token = process.env.BOT_TOKEN ?? '';
  return crypto.createHash('sha256').update(token + ':admin').digest('hex').slice(0, 24);
}

export const effectiveAdminSecret = getEffectiveSecret();
