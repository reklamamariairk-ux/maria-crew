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
import { normalizePhone } from '../../services/employeeAuth.service';

const router = Router();

router.use(employeeAuth);

// PATCH /api/v1/account — обновление профиля сотрудника из мобильного приложения.
// Можно менять name, phone, telegramPhotoUrl (аватарка). Email не редактируется.
router.patch('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const employeeId = req.employeeId!;
    const { name, phone, avatarUrl } = req.body as {
      name?: string; phone?: string; avatarUrl?: string | null;
    };

    const sets: string[] = [];
    const vals: (string | null | number)[] = [];

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 100) {
        res.status(400).json({ error: 'Имя должно быть от 1 до 100 символов' });
        return;
      }
      vals.push(trimmed); sets.push(`name = $${vals.length}`);
    }

    if (phone !== undefined) {
      const phoneNorm = normalizePhone(phone);
      if (phoneNorm.length !== 11) {
        res.status(400).json({ error: 'Неверный формат телефона. Введи 11 цифр' });
        return;
      }
      // Проверяем что номер не занят другим сотрудником
      const { rows: dup } = await pool.query<{ id: number }>(
        `SELECT id FROM employees WHERE phone_normalized = $1 AND id <> $2`,
        [phoneNorm, employeeId]
      );
      if (dup[0]) {
        res.status(409).json({ error: 'Этот номер уже занят другим сотрудником' });
        return;
      }
      vals.push('+' + phoneNorm); sets.push(`phone = $${vals.length}`);
      vals.push(phoneNorm); sets.push(`phone_normalized = $${vals.length}`);
    }

    if (avatarUrl !== undefined) {
      // Пустая строка / null → сбросить
      const url = avatarUrl && avatarUrl.trim() ? avatarUrl.trim() : null;
      vals.push(url); sets.push(`telegram_photo_url = $${vals.length}`);
    }

    if (sets.length === 0) {
      res.status(400).json({ error: 'Нечего обновлять' });
      return;
    }

    vals.push(employeeId);
    const { rows } = await pool.query(
      `UPDATE employees SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, name, phone, telegram_photo_url AS "telegramPhotoUrl",
                 store_id AS "storeId", role`,
      vals
    );
    if (!rows[0]) { res.status(404).json({ error: 'Не найден' }); return; }
    res.json(rows[0]);
    logAudit('employee_update', { employeeId, fields: { name, phone: phone ? '***' : undefined, avatarUrl: avatarUrl !== undefined } }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

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
