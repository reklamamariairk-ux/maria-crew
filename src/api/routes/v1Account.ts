// /api/v1/account — управление аккаунтом сотрудника из мобильного приложения.
//
// DELETE /api/v1/account — удаление аккаунта.
//   Требование Apple App Store с 2022: любое приложение с регистрацией обязано
//   предоставить кнопку «Удалить аккаунт» прямо в UI. Без этого билд отклонят.
//
// Делаем soft-delete + анонимизацию PII:
//   - is_active = false
//   - phone, telegram_username, telegram_id, telegram_photo_url, name → NULL
//   - История транзакций (coin_transactions, employee_cards, quiz_attempts) сохраняется,
//     но больше не привязана к личным данным.
//
// Hard-delete не делаем по двум причинам:
//   1. Бухгалтерская отчётность — нужна история начислений за период.
//   2. CASCADE удалил бы все carddrops/exchanges/metrics этого сотрудника,
//      что повлияло бы на агрегаты «всего по точке за месяц».

import { Router, Request, Response, NextFunction } from 'express';
import { employeeAuth } from '../middleware/employeeAuth';
import { pool } from '../../db/pool';
import { logAudit } from '../../services/audit.service';

const router = Router();

router.use(employeeAuth);

router.delete('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const employeeId = req.employeeId!;
    const { rows } = await pool.query<{ name: string }>(
      `UPDATE employees
       SET is_active = false,
           name = '[удалённый аккаунт]',
           phone = NULL,
           phone_normalized = NULL,
           telegram_id = NULL,
           telegram_username = NULL,
           telegram_photo_url = NULL
       WHERE id = $1
       RETURNING name`,
      [employeeId]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }

    // Чистим device_tokens чтобы не получать push после удаления
    await pool.query(`DELETE FROM device_tokens WHERE employee_id = $1`, [employeeId]);
    // Инвалидируем все авто-выданные PIN'ы
    await pool.query(`DELETE FROM auth_pins WHERE employee_id = $1`, [employeeId]);

    res.json({ ok: true });
    logAudit('employee_deactivate', { employeeId, reason: 'self_delete' }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
