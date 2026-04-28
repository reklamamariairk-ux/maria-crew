import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { logAudit } from '../../services/audit.service';

const router = Router();

// GET /api/heroes — все герои (основные + лимитные) для пикера в админке
router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, image_url AS "imageUrl",
              is_limited AS "isLimited", season, sort_order AS "sortOrder"
       FROM heroes
       ORDER BY is_limited, sort_order`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// PATCH /api/heroes/:id — обновить описание и/или image_url
router.patch('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { imageUrl, description } = req.body as { imageUrl?: string | null; description?: string | null };

    const sets: string[] = [];
    const vals: (string | null | number)[] = [];

    if (imageUrl !== undefined) {
      // Пустая строка → NULL (нет картинки)
      vals.push(imageUrl === '' ? null : (imageUrl ?? null));
      sets.push(`image_url = $${vals.length}`);
    }
    if (description !== undefined) {
      vals.push(description === '' ? null : (description ?? null));
      sets.push(`description = $${vals.length}`);
    }
    if (sets.length === 0) { res.status(400).json({ error: 'Нечего обновлять' }); return; }

    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE heroes SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, name, description, image_url AS "imageUrl", is_limited AS "isLimited"`,
      vals
    );
    if (!rows[0]) { res.status(404).json({ error: 'Герой не найден' }); return; }
    res.json(rows[0]);
    logAudit('hero_update', { heroId: id, imageUrl, description }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
