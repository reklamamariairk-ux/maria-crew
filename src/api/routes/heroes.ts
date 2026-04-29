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

// POST /api/heroes — создать нового героя
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, description, imageUrl, isLimited, season, sortOrder } = req.body as {
      name: string; description?: string; imageUrl?: string;
      isLimited?: boolean; season?: string; sortOrder?: number;
    };
    if (!name?.trim()) { res.status(400).json({ error: 'Имя обязательно' }); return; }

    const { rows } = await pool.query(
      `INSERT INTO heroes (name, description, image_url, is_limited, season, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, description, image_url AS "imageUrl",
                 is_limited AS "isLimited", season, sort_order AS "sortOrder"`,
      [name.trim(), description ?? null, imageUrl ?? null,
       isLimited ?? false, season ?? null, sortOrder ?? 0]
    );
    res.status(201).json(rows[0]);
    logAudit('hero_create', { heroId: rows[0].id, name }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

// DELETE /api/heroes/:id — удалить героя (только если нет карточек у сотрудников)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }

    const { rows: cards } = await pool.query(
      `SELECT id FROM employee_cards WHERE hero_id = $1 LIMIT 1`, [id]
    );
    if (cards[0]) {
      res.status(409).json({ error: 'Нельзя удалить: у сотрудников есть карточки этого героя' });
      return;
    }

    const { rowCount } = await pool.query(`DELETE FROM heroes WHERE id = $1`, [id]);
    if (!rowCount) { res.status(404).json({ error: 'Герой не найден' }); return; }
    res.json({ ok: true });
    logAudit('hero_delete', { heroId: id }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

// PATCH /api/heroes/:id — обновить имя, описание и/или image_url
router.patch('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, imageUrl, description } = req.body as {
      name?: string; imageUrl?: string | null; description?: string | null;
    };

    const sets: string[] = [];
    const vals: (string | null | number)[] = [];

    if (name !== undefined && name.trim()) {
      vals.push(name.trim());
      sets.push(`name = $${vals.length}`);
    }
    if (imageUrl !== undefined) {
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
    logAudit('hero_update', { heroId: id, name, imageUrl, description }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
