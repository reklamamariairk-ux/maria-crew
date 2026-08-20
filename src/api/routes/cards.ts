import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { notifyCardAward } from '../../bot/notifications/sender';
import { logAudit } from '../../services/audit.service';
import { areEmployeesInWorkspace, workspaceForRequest } from '../../services/adminWorkspace.service';

const router = Router();

// GET /api/cards/:employeeId — все карточки сотрудника
router.get('/:employeeId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    const workspace = workspaceForRequest(req);
    if (!(await areEmployeesInWorkspace([employeeId], workspace))) {
      res.status(403).json({ error: 'Сотрудник недоступен в текущем контуре' }); return;
    }
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
    const { employeeId, heroId, isMvp = false, source = 'manual', year, month } = req.body as {
      employeeId: number; heroId: number; isMvp?: boolean; source?: string;
      year?: number; month?: number;
    };
    if (!employeeId || !heroId) { res.status(400).json({ error: 'employeeId и heroId обязательны' }); return; }
    const workspace = workspaceForRequest(req);
    if (!(await areEmployeesInWorkspace([employeeId], workspace))) {
      res.status(403).json({ error: 'Сотрудник недоступен в текущем контуре' }); return;
    }

    const now = new Date();
    const finalYear  = (year  && year  >= 2024 && year  <= 2100) ? year  : now.getFullYear();
    const finalMonth = (month && month >= 1    && month <= 12  ) ? month : now.getMonth() + 1;
    const { rows } = await pool.query<{ id: number; heroName: string }>(
      `WITH inserted AS (
         INSERT INTO employee_cards (employee_id, hero_id, is_mvp, source, year, month)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, hero_id
       )
       SELECT i.id, h.name AS "heroName" FROM inserted i JOIN heroes h ON h.id = i.hero_id`,
      [employeeId, heroId, isMvp, source, finalYear, finalMonth]
    );
    res.status(201).json({ id: rows[0].id });

    notifyCardAward(employeeId, rows[0].heroName, source, isMvp).catch(() => {});
    logAudit('card_grant', { employeeId, heroId, source, isMvp, workspace }).catch(() => {});
  } catch (err) { next(err); }
});

// DELETE /api/cards/:id — отозвать (удалить) карточку.
// Защита: не удаляем потраченные карточки — на них ссылается store_exchanges.card_ids;
// удаление сломает возможность возврата при отклонении заявки и историю обменов.
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: existing } = await pool.query<{ isSpent: boolean; employeeId: number }>(
      `SELECT is_spent AS "isSpent", employee_id AS "employeeId" FROM employee_cards WHERE id = $1`,
      [id]
    );
    if (!existing[0]) { res.status(404).json({ error: 'Карточка не найдена' }); return; }
    const workspace = workspaceForRequest(req);
    if (!(await areEmployeesInWorkspace([existing[0].employeeId], workspace))) {
      res.status(403).json({ error: 'Карточка недоступна в текущем контуре' }); return;
    }
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
      logAudit('card_revoke', { cardId: id, employeeId: rows[0].employeeId, heroId: rows[0].heroId, workspace }).catch(() => {});
    }
  } catch (err) { next(err); }
});

// PATCH /api/cards/:id/spent — отметить «потрачена» / «не потрачена»
router.patch('/:id/spent', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { isSpent } = req.body as { isSpent: boolean };
    const owner = await pool.query<{ employeeId: number }>(
      `SELECT employee_id AS "employeeId" FROM employee_cards WHERE id = $1`, [id],
    );
    if (!owner.rows[0]) { res.status(404).json({ error: 'Карточка не найдена' }); return; }
    const workspace = workspaceForRequest(req);
    if (!(await areEmployeesInWorkspace([owner.rows[0].employeeId], workspace))) {
      res.status(403).json({ error: 'Карточка недоступна в текущем контуре' }); return;
    }
    const { rowCount } = await pool.query(
      `UPDATE employee_cards SET is_spent = $1 WHERE id = $2`,
      [isSpent, id]
    );
    if (!rowCount) { res.status(404).json({ error: 'Карточка не найдена' }); return; }
    res.json({ ok: true });
    logAudit('card_spent_toggle', { cardId: id, isSpent, workspace }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
