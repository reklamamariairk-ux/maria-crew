import { Router, Request, Response } from 'express';

const router = Router();

router.post('/login', (req: Request, res: Response): void => {
  const { secret } = req.body as { secret?: string };

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Неверный ключ' });
    return;
  }

  res.json({ token: process.env.ADMIN_SECRET });
});

export default router;
