import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { logAudit } from '../../services/audit.service';

const router = Router();

const PRIZE_TYPES = [
  'cake', 'certificate', 'cash', 'shift_choice', 'golden_badge',
  'coffee', 'discount', 'merch', 'break',
];

// GET /api/prizes — все призы (включая скрытые)
router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, prize_type AS "prizeType",
              cards_required AS "cardsRequired", coins_required AS "coinsRequired",
              is_active AS "isActive", sort_order AS "sortOrder"
       FROM prizes
       ORDER BY sort_order, id`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/prizes — создать
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      name, description, prizeType, cardsRequired, coinsRequired, sortOrder,
    } = req.body as {
      name: string; description?: string; prizeType: string;
      cardsRequired?: number; coinsRequired?: number; sortOrder?: number;
    };
    if (!name || !name.trim()) { res.status(400).json({ error: 'name обязателен' }); return; }
    if (!PRIZE_TYPES.includes(prizeType)) {
      res.status(400).json({ error: `prizeType должен быть один из: ${PRIZE_TYPES.join(', ')}` });
      return;
    }
    const cards = Number.isFinite(cardsRequired) ? cardsRequired : 0;
    const coins = Number.isFinite(coinsRequired) ? coinsRequired : 0;
    if ((cards ?? 0) === 0 && (coins ?? 0) === 0) {
      res.status(400).json({ error: 'Укажи стоимость в карточках или монетах (или обе)' });
      return;
    }

    const { rows } = await pool.query(
      `INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, description, prize_type AS "prizeType",
                 cards_required AS "cardsRequired", coins_required AS "coinsRequired",
                 is_active AS "isActive", sort_order AS "sortOrder"`,
      [name.trim(), description?.trim() || null, prizeType, cards ?? 0, coins ?? 0, sortOrder ?? 999]
    );
    res.status(201).json(rows[0]);
    logAudit('prize_create', { prizeId: rows[0].id, name: rows[0].name }).catch(() => {});
  } catch (err) { next(err); }
});

// PUT /api/prizes/:id — обновить
router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as {
      name?: string; description?: string | null; prizeType?: string;
      cardsRequired?: number; coinsRequired?: number;
      isActive?: boolean; sortOrder?: number;
    };
    const sets: string[] = [];
    const vals: (string | number | boolean | null)[] = [];

    if (body.name !== undefined) { vals.push(body.name); sets.push(`name = $${vals.length}`); }
    if (body.description !== undefined) { vals.push(body.description ?? null); sets.push(`description = $${vals.length}`); }
    if (body.prizeType !== undefined) {
      if (!PRIZE_TYPES.includes(body.prizeType)) {
        res.status(400).json({ error: `prizeType должен быть один из: ${PRIZE_TYPES.join(', ')}` });
        return;
      }
      vals.push(body.prizeType); sets.push(`prize_type = $${vals.length}`);
    }
    if (body.cardsRequired !== undefined) { vals.push(body.cardsRequired); sets.push(`cards_required = $${vals.length}`); }
    if (body.coinsRequired !== undefined) { vals.push(body.coinsRequired); sets.push(`coins_required = $${vals.length}`); }
    if (body.isActive !== undefined) { vals.push(body.isActive); sets.push(`is_active = $${vals.length}`); }
    if (body.sortOrder !== undefined) { vals.push(body.sortOrder); sets.push(`sort_order = $${vals.length}`); }

    if (!sets.length) { res.status(400).json({ error: 'Нечего обновлять' }); return; }

    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE prizes SET ${sets.join(', ')}
       WHERE id = $${vals.length}
       RETURNING id, name, description, prize_type AS "prizeType",
                 cards_required AS "cardsRequired", coins_required AS "coinsRequired",
                 is_active AS "isActive", sort_order AS "sortOrder"`,
      vals
    );
    if (!rows[0]) { res.status(404).json({ error: 'Приз не найден' }); return; }
    res.json(rows[0]);
    logAudit('prize_update', { prizeId: rows[0].id, changes: body }).catch(() => {});
  } catch (err) { next(err); }
});

// DELETE /api/prizes/:id — удалить (только если ни одной заявки не было)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: usage } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM store_exchanges WHERE prize_id = $1`,
      [id]
    );
    if (parseInt(usage[0]?.count ?? '0', 10) > 0) {
      res.status(409).json({
        error: 'Приз нельзя удалить — на него есть заявки. Сделай его «Скрытым» через переключатель.'
      });
      return;
    }
    const { rowCount } = await pool.query(`DELETE FROM prizes WHERE id = $1`, [id]);
    if (!rowCount) { res.status(404).json({ error: 'Приз не найден' }); return; }
    res.json({ ok: true });
    logAudit('prize_delete', { prizeId: id }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
