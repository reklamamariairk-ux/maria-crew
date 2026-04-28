import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();
const MAX_STORE_SIZE = 10_000;

// Очищаем устаревшие записи каждые 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.resetAt) store.delete(key);
  }
}, 300_000).unref(); // unref: не держим процесс живым только ради этого таймера

/** Лимит по IP: windowMs мс, max запросов.
 *  Требует app.set('trust proxy', 1) для корректного req.ip на Render. */
export function rateLimit(max: number, windowMs: number) {
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    // req.ip корректен при trust proxy = 1; Express берёт первый адрес из X-Forwarded-For
    const key = req.ip ?? 'unknown';
    const now = Date.now();

    // Защита от unbounded memory growth
    if (store.size >= MAX_STORE_SIZE) {
      next();
      return;
    }

    const entry = store.get(key);
    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count++;
    if (entry.count > max) {
      res.status(429).json({ error: 'Слишком много запросов. Подождите немного.' });
      return;
    }

    next();
  };
}
