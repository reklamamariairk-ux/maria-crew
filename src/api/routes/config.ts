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
    // Веса и пороги 0–100 (всё что относится к шкале % метрик)
    const allowed0to100 = ['mysteryShopperWeight', 'mysteryShopperThreshold',
                     'reviewsPerCard', 'reviewsMax',
                     'checklistWeight', 'checklistThreshold',
                     'revenueWeightFactor', 'revenueMax',
                     'cardThresholdMysteryShopper', 'cardThresholdChecklist'] as const;
    // Порог по плану выручки может быть > 100 (перевыполнение), кэп 0–300
    const allowed0to300 = ['cardThresholdRevenue'] as const;
    // Лимит карточек-отзывов — целое 0–20
    const allowedIntCount = ['cardMaxReviewsCount'] as const;
    const allowedCoins = ['mvpCoinReward', 'topStoreCoinReward'] as const;

    const body = req.body as Record<string, unknown>;
    const data: Record<string, number> = {};

    for (const key of allowed0to100) {
      if (key in body) {
        const val = Number(body[key]);
        if (isNaN(val) || val < 0 || val > 100) {
          res.status(400).json({ error: `${key} должен быть числом от 0 до 100` });
          return;
        }
        data[key] = val;
      }
    }

    for (const key of allowed0to300) {
      if (key in body) {
        const val = Number(body[key]);
        if (isNaN(val) || val < 0 || val > 300) {
          res.status(400).json({ error: `${key} должен быть числом от 0 до 300` });
          return;
        }
        data[key] = val;
      }
    }

    for (const key of allowedIntCount) {
      if (key in body) {
        const val = Number(body[key]);
        if (isNaN(val) || val < 0 || val > 20 || !Number.isInteger(val)) {
          res.status(400).json({ error: `${key} должен быть целым числом от 0 до 20` });
          return;
        }
        data[key] = val;
      }
    }

    for (const key of allowedCoins) {
      if (key in body) {
        const val = Number(body[key]);
        if (isNaN(val) || val < 0 || val > 10000) {
          res.status(400).json({ error: `${key} должен быть числом от 0 до 10000` });
          return;
        }
        data[key] = Math.round(val);
      }
    }

    const config = await updateMvpConfig(data);
    res.json(config);
    logAudit('config_update', { type: 'mvp', changes: data }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

// GET /api/config/cloudinary — публичные параметры для загрузки изображений
router.get('/cloudinary', (_req: Request, res: Response): void => {
  const cloudName    = process.env.CLOUDINARY_CLOUD_NAME    ?? '';
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET ?? '';
  res.json({ cloudName, uploadPreset, enabled: !!(cloudName && uploadPreset) });
});

export default router;
