import { Router, Request, Response, NextFunction } from 'express';
import { listCakePrizes, addManualCakePrize } from '../../services/cakePrize.service';
import { notifyCakePrizes } from '../../bot/notifications/sender';
import { pool } from '../../db/pool';
import { logAudit } from '../../services/audit.service';

// «Торты месяца» (админка, таб Рейтинги): список, ручное добавление сотрудника,
// удаление ошибочной записи. coin_admin отрезан на уровне router.ts.
// НЕ путать с routes/prizes.ts — это магазин призов за карточки.
const router = Router();

// GET /api/cake-prizes?year=&month=
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const year = parseInt(String(req.query.year), 10);
    const month = parseInt(String(req.query.month), 10);
    if (!year || !month) { res.status(400).json({ error: 'year, month обязательны' }); return; }
    res.json(await listCakePrizes(year, month));
  } catch (err) { next(err); }
});

// POST /api/cake-prizes/employee {year, month, employeeId} — добавить ещё одного
// сотрудника к «торту месяца». Уведомление уходит сразу (если created).
router.post('/employee', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { year, month, employeeId } = req.body as { year?: number; month?: number; employeeId?: number };
    if (!year || !month || !Number.isInteger(employeeId)) {
      res.status(400).json({ error: 'year, month, employeeId обязательны' }); return;
    }
    const winner = await addManualCakePrize(year, month, employeeId!, `admin#${req.adminUserId ?? '?'}`);
    if (!winner) { res.status(400).json({ error: 'employee_not_found_or_fired' }); return; }
    if (!winner.created) { res.status(409).json({ error: 'already_awarded' }); return; }
    res.json({ ok: true, winner });
    notifyCakePrizes([winner], month, year).catch(e => console.error('[cake-prizes] notify failed:', e));
  } catch (err) { next(err); }
});

// DELETE /api/cake-prizes/:id — убрать ошибочную запись (уведомление не отзывается).
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }
    const { rows } = await pool.query(
      `DELETE FROM monthly_prizes WHERE id = $1 RETURNING year, month, kind, employee_id, store_id`, [id]);
    if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }
    res.json({ ok: true });
    logAudit('cake_prize', { removed: true, prizeId: id, ...rows[0] }, `admin#${req.adminUserId ?? '?'}`).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
