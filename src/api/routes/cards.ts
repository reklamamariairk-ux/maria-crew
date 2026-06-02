import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { notifyCardAward } from '../../bot/notifications/sender';
import { logAudit } from '../../services/audit.service';

const router = Router();

// GET /api/cards/:employeeId — все карточки сотрудника
router.get('/:employeeId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    const { rows } = await pool.query(
      `SELECT ec.id, ec.hero_id AS "heroId", ec.is_mvp AS "isMvp", ec.source,
              ec.year, ec.month, ec.is_spent AS "isSpent", ec.earned_at AS "earnedAt",
              h.name AS "heroName", h.is_limited AS "heroLimited"
       FROM employee_cards ec
       JOIN heroes h ON h.id = ec.hero_id
       WHERE ec.employee_id = $1
       ORDER BY ec.earned_at DESC`,
      [employeeId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/cards — выдать карточку вручную
// body: { employeeId, heroId, isMvp?, source? }
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { employeeId, heroId, isMvp = false, source = 'manual' } = req.body as {
      employeeId: number; heroId: number; isMvp?: boolean; source?: string;
    };
    if (!employeeId || !heroId) { res.status(400).json({ error: 'employeeId и heroId обязательны' }); return; }

    const now = new Date();
    const { rows } = await pool.query<{ id: number; heroName: string }>(
      `WITH inserted AS (
         INSERT INTO employee_cards (employee_id, hero_id, is_mvp, source, year, month)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, hero_id
       )
       SELECT i.id, h.name AS "heroName" FROM inserted i JOIN heroes h ON h.id = i.hero_id`,
      [employeeId, heroId, isMvp, source, now.getFullYear(), now.getMonth() + 1]
    );
    res.status(201).json({ id: rows[0].id });

    notifyCardAward(employeeId, rows[0].heroName, source, isMvp).catch(() => {});
    logAudit('card_grant', { employeeId, heroId, source, isMvp }).catch(() => {});
  } catch (err) { next(err); }
});

// DELETE /api/cards/:id — отозвать (удалить) карточку.
// Защита: не удаляем потраченные карточки — на них ссылается store_exchanges.card_ids;
// удаление сломает возможность возврата при отклонении заявки и историю обменов.
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: existing } = await pool.query<{ isSpent: boolean }>(
      `SELECT is_spent AS "isSpent" FROM employee_cards WHERE id = $1`,
      [id]
    );
    if (!existing[0]) { res.status(404).json({ error: 'Карточка не найдена' }); return; }
    if (existing[0].isSpent) {
      res.status(409).json({
        error: 'Нельзя удалить потраченную карточку — она связана с заявкой на приз. Если нужно «отменить» обмен, отклони соответствующую заявку.',
      });
      return;
    }

    const { rows } = await pool.query<{ employeeId: number; heroId: number }>(
      `DELETE FROM employee_cards WHERE id = $1
       RETURNING employee_id AS "employeeId", hero_id AS "heroId"`,
      [id]
    );
    res.json({ ok: true });
    // rows[0] может быть пустым при гонке (карту удалили между SELECT и DELETE) — не роняем обработчик
    if (rows[0]) {
      logAudit('card_revoke', { cardId: id, employeeId: rows[0].employeeId, heroId: rows[0].heroId }).catch(() => {});
    }
  } catch (err) { next(err); }
});

// PATCH /api/cards/:id/spent — отметить «потрачена» / «не потрачена»
router.patch('/:id/spent', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { isSpent } = req.body as { isSpent: boolean };
    const { rowCount } = await pool.query(
      `UPDATE employee_cards SET is_spent = $1 WHERE id = $2`,
      [isSpent, id]
    );
    if (!rowCount) { res.status(404).json({ error: 'Карточка не найдена' }); return; }
    res.json({ ok: true });
    logAudit('card_spent_toggle', { cardId: id, isSpent }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
