import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { earn, getHistory, getBalance } from '../../services/coin.service';
import { notifyCoinAward } from '../../bot/notifications/sender';
import { logAudit } from '../../services/audit.service';
import { requireRole } from '../middleware/adminAuth';
import type { CoinReason } from '../../types';

const router = Router();

// POST /api/coins/award — только superadmin или coin_admin
router.post('/award', requireRole('superadmin', 'coin_admin'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { employeeId, reason, amount, createdBy, note } = req.body as {
      employeeId: number; reason: Exclude<CoinReason, 'spend'>;
      amount?: number; createdBy?: number; note?: string;
    };
    if (!employeeId || !reason) {
      res.status(400).json({ error: 'employeeId и reason обязательны' }); return;
    }

    let actualAmount: number;
    let tx: { id?: number };
    const performer = req.adminUserId ?? createdBy ?? null;

    // Manual может быть отрицательным (списание) — пишем напрямую.
    // Защита от ухода баланса ниже 0: списываем максимум сколько есть.
    if (reason === 'manual' && typeof amount === 'number' && amount < 0) {
      const balance = await getBalance(employeeId);
      if (balance === 0) {
        res.status(400).json({ error: 'Нечего списывать — баланс сотрудника 0' });
        return;
      }
      const adjusted = -Math.min(Math.abs(amount), balance);
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO coin_transactions (employee_id, amount, reason, note, created_by)
         VALUES ($1, $2, 'manual', $3, $4)
         RETURNING id`,
        [employeeId, adjusted, note ?? null, performer]
      );
      tx = rows[0];
      actualAmount = adjusted;
      res.status(201).json(tx);
    } else {
      const created = await earn({ employeeId, reason, amount, createdBy: performer ?? undefined, note });
      tx = created;
      actualAmount = created.amount;
      res.status(201).json(tx);
    }

    // Async: уведомление + аудит — не блокируем ответ, но ошибки логируем
    notifyCoinAward(employeeId, actualAmount, reason, note).catch(err =>
      console.error('[notify] coin_award failed:', err instanceof Error ? err.message : err));
    logAudit('coin_award', { employeeId, amount: actualAmount, reason, note: note ?? null }).catch(err =>
      console.error('[audit] coin_award failed:', err instanceof Error ? err.message : err));
  } catch (err) { next(err); }
});

// GET /api/coins/balance/:employeeId
router.get('/balance/:employeeId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const balance = await getBalance(parseInt(req.params.employeeId, 10));
    res.json({ balance });
  } catch (err) { next(err); }
});

// GET /api/coins/history/:employeeId
router.get('/history/:employeeId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = parseInt((req.query.limit as string) ?? '20', 10);
    const history = await getHistory(parseInt(req.params.employeeId, 10), limit);
    res.json(history);
  } catch (err) { next(err); }
});

// GET /api/coins/export?from=YYYY-MM-DD&to=YYYY-MM-DD&storeId=
// Возвращает CSV всех начислений монет за период (для бухгалтерии).
router.get('/export', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const from = String(req.query.from ?? '').trim();
    const to   = String(req.query.to   ?? '').trim();
    const storeIdRaw = String(req.query.storeId ?? '').trim();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRe.test(from) || !dateRe.test(to)) {
      res.status(400).json({ error: 'from и to обязательны в формате YYYY-MM-DD' });
      return;
    }
    // Ограничение диапазона: максимум 1 год — иначе можно ненароком выгрузить
    // миллионы строк и положить процесс по памяти.
    const fromMs = Date.parse(from);
    const toMs   = Date.parse(to);
    if (isNaN(fromMs) || isNaN(toMs)) {
      res.status(400).json({ error: 'Некорректные даты' });
      return;
    }
    if (toMs < fromMs) {
      res.status(400).json({ error: 'to должен быть >= from' });
      return;
    }
    if (toMs - fromMs > 366 * 24 * 60 * 60 * 1000) {
      res.status(400).json({ error: 'Диапазон слишком большой (максимум 1 год)' });
      return;
    }

    const params: (string | number)[] = [from, to];
    let storeFilter = '';
    if (storeIdRaw) {
      const storeId = parseInt(storeIdRaw, 10);
      if (!isNaN(storeId)) { params.push(storeId); storeFilter = ` AND e.store_id = $${params.length}`; }
    }

    const { rows } = await pool.query<{
      createdAt: Date; employeeName: string; storeName: string;
      amount: number; reason: string; note: string | null;
    }>(
      `SELECT ct.created_at AS "createdAt",
              e.name        AS "employeeName",
              s.name        AS "storeName",
              ct.amount, ct.reason, ct.note
       FROM coin_transactions ct
       JOIN employees e ON e.id = ct.employee_id
       LEFT JOIN stores s ON s.id = e.store_id
       WHERE ct.created_at >= $1::date
         AND ct.created_at <  ($2::date + INTERVAL '1 day')
         ${storeFilter}
       ORDER BY ct.created_at ASC`,
      params
    );

    const REASON_LABELS: Record<string, string> = {
      checklist_day: 'Чек-лист 100%', review: 'Именной отзыв', cake_order: 'Торт на заказ',
      substitution: 'Подмена коллеги', mentoring: 'Наставничество', idea: 'Идея',
      training_meeting: 'Собрание', knowledge_applied: 'Применение знаний',
      plan_100: 'Выполнение плана 100%', plan_105: 'Перевыполнение плана >105%',
      bad_review: 'Отрицательный отзыв', dirty_store: 'Нарушение чистоты',
      training_resistance: 'Сопротивление обучению', spend: 'Обмен в Store',
      manual: 'Вручную', quiz: 'Квиз', checkin: 'Ежедневный вход',
    };

    // CSV: discreet escaping для запятых, ковычек, переводов строк
    const esc = (v: string | number | null | undefined) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = ['Дата', 'Сотрудник', 'Точка', 'Сумма', 'Причина', 'Примечание'];
    const lines = [header.join(';')];
    for (const r of rows) {
      const date = new Date(r.createdAt);
      // Иркутское представление
      const irk = new Date(date.getTime() + 8 * 60 * 60 * 1000);
      const ds = irk.toISOString().slice(0, 16).replace('T', ' ');
      lines.push([
        esc(ds),
        esc(r.employeeName),
        esc(r.storeName ?? ''),
        esc(r.amount),
        esc(REASON_LABELS[r.reason] ?? r.reason),
        esc(r.note ?? ''),
      ].join(';'));
    }

    const filename = `coins_${from}_${to}.csv`;
    // BOM для Excel — чтобы кириллица не сломалась
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) { next(err); }
});

export default router;
