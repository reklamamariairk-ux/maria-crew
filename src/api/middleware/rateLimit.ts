import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();
const MAX_STORE_SIZE = 10_000;
let limiterSeq = 0;

function sweepExpired(now: number): void {
  for (const [key, entry] of store.entries()) {
    if (now > entry.resetAt) store.delete(key);
  }
}

// Очищаем устаревшие записи каждые 5 минут
setInterval(() => sweepExpired(Date.now()), 300_000).unref(); // unref: не держим процесс живым только ради этого таймера

/** Лимит по IP: windowMs мс, max запросов.
 *  Требует app.set('trust proxy', 1) для корректного req.ip на Render.
 *  Каждый вызов rateLimit() получает свой namespace ключа — счётчики разных
 *  лимитеров (/auth, /webapp, /v1/auth, ...) НЕ протекают друг в друга. */
export function rateLimit(max: number, windowMs: number) {
  const ns = `${++limiterSeq}:${max}:${windowMs}`;
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    // req.ip корректен при trust proxy = 1; Express берёт первый адрес из X-Forwarded-For
    const key = `${ns}|${req.ip ?? 'unknown'}`;
    const now = Date.now();

    // Защита от unbounded memory growth. НЕ делаем fail-open (это отключало бы
    // защиту логина от перебора): чистим протухшие, при переполнении вытесняем
    // самую старую запись, но лимитирование остаётся активным.
    if (store.size >= MAX_STORE_SIZE) {
      sweepExpired(now);
      if (store.size >= MAX_STORE_SIZE) {
        let oldestKey: string | undefined;
        let oldestAt = Infinity;
        for (const [k, e] of store.entries()) {
          if (e.resetAt < oldestAt) { oldestAt = e.resetAt; oldestKey = k; }
        }
        if (oldestKey !== undefined) store.delete(oldestKey);
      }
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
