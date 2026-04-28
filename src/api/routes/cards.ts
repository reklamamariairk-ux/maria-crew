import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';

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
    const { rows } = await pool.query(
      `INSERT INTO employee_cards (employee_id, hero_id, is_mvp, source, year, month)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [employeeId, heroId, isMvp, source, now.getFullYear(), now.getMonth() + 1]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) { next(err); }
});

// DELETE /api/cards/:id — отозвать (удалить) карточку
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await pool.query(`DELETE FROM employee_cards WHERE id = $1`, [id]);
    if (!rowCount) { res.status(404).json({ error: 'Карточка не найдена' }); return; }
    res.json({ ok: true });
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
  } catch (err) { next(err); }
});

export default router;
