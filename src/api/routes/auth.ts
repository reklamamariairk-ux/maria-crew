import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, signToken } from '../../services/adminAuth.service';

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
    res.json({ token, role: result.role });
  } catch (err) { next(err); }
});

export default router;
