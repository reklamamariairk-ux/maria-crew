import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, signToken, changeOwnPassword } from '../../services/adminAuth.service';
import { adminAuth } from '../middleware/adminAuth';

const router = Router();

router.post('/login', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: 'username и password обязательны' });
      return;
    }

    const result = await authenticate(username.trim(), password);
    if (!result) {
      res.status(401).json({ error: 'Неверный логин или пароль' });
      return;
    }

    const token = signToken(result.uid, result.role);
    res.json({
      token,
      role: result.role,
      mustChangePassword: result.mustChangePassword,
    });
  } catch (err) { next(err); }
});

// POST /api/auth/change-password — смена своего пароля (любой авторизованный админ)
// body: { oldPassword, newPassword }
router.post('/change-password', adminAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string };
    if (!oldPassword || !newPassword) {
      res.status(400).json({ error: 'oldPassword и newPassword обязательны' });
      return;
    }
    if (newPassword.length < 4) {
      res.status(400).json({ error: 'Пароль минимум 4 символа' });
      return;
    }
    if (oldPassword === newPassword) {
      res.status(400).json({ error: 'Новый пароль должен отличаться от старого' });
      return;
    }
    const ok = await changeOwnPassword(req.adminUserId!, oldPassword, newPassword);
    if (!ok) {
      res.status(401).json({ error: 'Неверный текущий пароль' });
      return;
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
