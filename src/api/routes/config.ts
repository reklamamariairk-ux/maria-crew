import { Router, Request, Response, NextFunction } from 'express';
import { getMvpConfig, updateMvpConfig } from '../../services/mvpConfig.service';
import { logAudit } from '../../services/audit.service';

const router = Router();

// GET /api/config/mvp
router.get('/mvp', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await getMvpConfig());
  } catch (err) { next(err); }
});

// PUT /api/config/mvp
router.put('/mvp', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const allowed = ['mysteryShopperWeight', 'reviewsPerCard', 'reviewsMax',
                     'checklistWeight', 'revenueWeightFactor', 'revenueMax'] as const;
    const body = req.body as Record<string, unknown>;
    const data: Record<string, number> = {};

    for (const key of allowed) {
      if (key in body) {
        const val = Number(body[key]);
        if (isNaN(val) || val < 0 || val > 100) {
          res.status(400).json({ error: `${key} должен быть числом от 0 до 100` });
          return;
        }
        data[key] = val;
      }
    }

    const config = await updateMvpConfig(data);
    res.json(config);
    logAudit('config_update', { type: 'mvp', changes: data }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
