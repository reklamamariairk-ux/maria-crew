import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// Если ADMIN_SECRET не задан в env, деривируем его из BOT_TOKEN.
// Используется для автоматического старта без ручной настройки секрета.
function getEffectiveSecret(): string {
  if (process.env.ADMIN_SECRET) return process.env.ADMIN_SECRET;
  const token = process.env.BOT_TOKEN ?? '';
  return crypto.createHash('sha256').update(token + ':admin').digest('hex').slice(0, 24);
}

export const effectiveAdminSecret = getEffectiveSecret();

const secretBuffer = Buffer.from(`Bearer ${effectiveAdminSecret}`);

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization ?? '';
  const authBuffer = Buffer.from(auth);
  // Timing-safe comparison prevents timing oracle attacks
  const match =
    authBuffer.length === secretBuffer.length &&
    crypto.timingSafeEqual(authBuffer, secretBuffer);
  if (!match) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
