import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { logAudit } from '../../services/audit.service';
import { workspaceForRequest } from '../../services/adminWorkspace.service';

const router = Router();

const CAT_SELECT = `
  SELECT id, name, emoji, sort_order AS "sortOrder", is_active AS "isActive"
  FROM prize_categories
`;

// GET /api/categories — все категории призов (для дропдаунов и управления).
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `${CAT_SELECT} WHERE workspace = $1 ORDER BY sort_order, id`,
      [workspaceForRequest(req)],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/categories — создать категорию
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as { name?: string; emoji?: string | null; sortOrder?: number };
    const name = (body.name ?? '').trim();
    if (!name) { res.status(400).json({ error: 'name обязателен' }); return; }
    const emoji = body.emoji != null ? String(body.emoji).trim().slice(0, 16) || null : null;
    const sortOrder = Number.isFinite(body.sortOrder as number) ? Number(body.sortOrder) : 100;
    const { rows } = await pool.query(
      `INSERT INTO prize_categories (name, emoji, sort_order, workspace)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, emoji, sort_order AS "sortOrder", is_active AS "isActive"`,
      [name, emoji, sortOrder, workspaceForRequest(req)]
    );
    res.status(201).json(rows[0]);
    logAudit('prize_category_create', { id: rows[0].id, name }).catch(() => {});
  } catch (err) { next(err); }
});

// PATCH /api/categories/:id — обновить (имя/emoji/порядок/активность)
router.patch('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as { name?: string; emoji?: string | null; sortOrder?: number; isActive?: boolean };
    const sets: string[] = [];
    const vals: (string | number | boolean | null)[] = [];
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) { res.status(400).json({ error: 'name не может быть пустым' }); return; }
      vals.push(name); sets.push(`name = $${vals.length}`);
    }
    if (body.emoji !== undefined) {
      const emoji = body.emoji != null ? String(body.emoji).trim().slice(0, 16) || null : null;
      vals.push(emoji); sets.push(`emoji = $${vals.length}`);
    }
    if (body.sortOrder !== undefined) { vals.push(Number(body.sortOrder) || 0); sets.push(`sort_order = $${vals.length}`); }
    if (body.isActive !== undefined) { vals.push(!!body.isActive); sets.push(`is_active = $${vals.length}`); }
    if (!sets.length) { res.status(400).json({ error: 'Нечего обновлять' }); return; }
    vals.push(parseInt(req.params.id, 10));
    vals.push(workspaceForRequest(req));
    const { rows } = await pool.query(
      `UPDATE prize_categories SET ${sets.join(', ')}
       WHERE id = $${vals.length - 1} AND workspace = $${vals.length}
       RETURNING id, name, emoji, sort_order AS "sortOrder", is_active AS "isActive"`,
      vals
    );
    if (!rows[0]) { res.status(404).json({ error: 'Категория не найдена' }); return; }
    res.json(rows[0]);
    logAudit('prize_category_update', { id: rows[0].id, changes: body }).catch(() => {});
  } catch (err) { next(err); }
});

// DELETE /api/categories/:id — удалить. Призы этой категории становятся
// «без категории» (FK ON DELETE SET NULL) — попадут в бакет «Прочее».
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await pool.query(
      `DELETE FROM prize_categories WHERE id = $1 AND workspace = $2`,
      [id, workspaceForRequest(req)],
    );
    if (!rowCount) { res.status(404).json({ error: 'Категория не найдена' }); return; }
    res.json({ ok: true });
    logAudit('prize_category_delete', { id }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
