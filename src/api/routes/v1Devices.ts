// /api/v1/devices — регистрация push-токенов для мобильного приложения.
// Авторизация — JWT сотрудника (employeeAuth).

import { Router, Request, Response, NextFunction } from 'express';
import { employeeAuth } from '../middleware/employeeAuth';
import { registerDeviceToken, unregisterDeviceToken } from '../../services/push.service';

const router = Router();

router.use(employeeAuth);

// POST /api/v1/devices — регистрация / обновление токена устройства
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { token, platform, appVersion, deviceModel } = req.body as {
      token?: string; platform?: 'ios' | 'android' | 'web';
      appVersion?: string; deviceModel?: string;
    };
    if (!token || !platform) {
      res.status(400).json({ error: 'token и platform обязательны' });
      return;
    }
    if (!['ios', 'android', 'web'].includes(platform)) {
      res.status(400).json({ error: 'platform должна быть ios, android или web' });
      return;
    }
    await registerDeviceToken(req.employeeId!, token, platform, { appVersion, deviceModel });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/v1/devices/:token — удаление токена (logout / приложение удалено)
router.delete('/:token', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await unregisterDeviceToken(req.params.token, req.employeeId!);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
