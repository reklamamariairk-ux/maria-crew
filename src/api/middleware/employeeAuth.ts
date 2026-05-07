// Middleware для маршрутов мобильного приложения / standalone веб-клиента.
// Принимает Bearer JWT, выпущенный через POST /api/v1/auth/verify-pin.
// Кладёт req.employeeId, чтобы роуты могли отличить «mobile-аутентификация»
// от «Telegram initData» (хотя на бизнес-логике это не сказывается).

import { Request, Response, NextFunction } from 'express';
import { verifyEmployeeToken } from '../../services/employeeAuth.service';
import { pool } from '../../db/pool';
import type { Employee } from '../../types/index';

declare module 'express-serve-static-core' {
  interface Request {
    /** Установлено employeeAuth middleware. Гарантирует существующего активного employee. */
    employeeId?: number;
    employeeFromMobile?: Employee;
  }
}

export async function employeeAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = token ? verifyEmployeeToken(token) : null;
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { rows } = await pool.query<Employee>(
    `SELECT e.id, e.name, e.store_id AS "storeId", s.name AS "storeName",
            e.telegram_id AS "telegramId", e.telegram_username AS "telegramUsername",
            e.telegram_photo_url AS "telegramPhotoUrl", e.role, e.phone
     FROM employees e LEFT JOIN stores s ON s.id = e.store_id
     WHERE e.id = $1 AND e.is_active = true`,
    [payload.uid]
  );
  if (!rows[0]) {
    res.status(403).json({ error: 'Сотрудник деактивирован' });
    return;
  }
  req.employeeId = payload.uid;
  req.employeeFromMobile = rows[0];
  next();
}
