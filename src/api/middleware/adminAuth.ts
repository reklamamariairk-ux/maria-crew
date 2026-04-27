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

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${effectiveAdminSecret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
