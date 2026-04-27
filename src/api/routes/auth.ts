import { Router, Request, Response } from 'express';
import { effectiveAdminSecret } from '../middleware/adminAuth';

const router = Router();

router.post('/login', (req: Request, res: Response): void => {
  const { secret } = req.body as { secret?: string };

  if (!secret || secret !== effectiveAdminSecret) {
    res.status(401).json({ error: 'Неверный ключ' });
    return;
  }

  res.json({ token: effectiveAdminSecret });
});

export default router;
