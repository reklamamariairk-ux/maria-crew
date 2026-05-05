import { pool } from '../../db/pool';
import { irkutskDate } from '../../services/streak.service';

/**
 * Запускается каждый будний день в 20:00.
 * Напоминает руководителям начислить монеты за сегодня.
 */
export async function remindDailyCoins(
  sendMessage: (telegramId: string, html: string) => Promise<void>
): Promise<void> {
  const { rows: managers } = await pool.query<{
    telegramId: string; storeId: number; storeName: string;
  }>(
    `SELECT e.telegram_id::text AS "telegramId", e.store_id AS "storeId", s.name AS "storeName"
     FROM employees e
     JOIN stores s ON s.id = e.store_id
     WHERE e.role IN ('manager', 'admin')
       AND e.is_active = true
       AND e.telegram_id IS NOT NULL`
  );

  if (managers.length === 0) return;

  // Для каждой точки — сколько сотрудников ещё не получили монету за чек-лист сегодня.
  // Используем иркутский день — иначе на стыке дней по UTC сотрудник, получивший
  // монету вечером (уже после 16:00 UTC), мог бы попасть «в завтра» и руководитель
  // получил бы напоминание, что сотруднику не начислено.
  const today = irkutskDate();

  let sent = 0;
  for (const manager of managers) {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM employees e
       WHERE e.store_id = $1
         AND e.is_active = true
         AND NOT EXISTS (
           SELECT 1 FROM coin_transactions ct
           WHERE ct.employee_id = e.id
             AND ct.reason = 'checklist_day'
             AND (ct.created_at AT TIME ZONE 'Asia/Irkutsk')::date = $2::date
         )`,
      [manager.storeId, today]
    );

    const pending = parseInt(rows[0].count, 10);
    if (pending === 0) continue; // все уже начислены

    const text =
      `💰 <b>Не забудьте про монеты!</b>\n\n` +
      `Сегодня <b>${pending} ${empWord(pending)}</b> из <b>${manager.storeName}</b> ` +
      `ещё не получили монету за чек-лист.\n\n` +
      `Начислите через Admin Panel → вкладка <b>Монеты</b>.`;

    try {
      await sendMessage(manager.telegramId, text);
      sent++;
    } catch { /* пользователь заблокировал бота — игнорируем */ }
  }

  if (sent > 0) {
    console.log(`[scheduler] remindDailyCoins: отправлено ${sent} напоминаний`);
  }
}

function empWord(n: number): string {
  if (n === 1) return 'сотрудник';
  if (n >= 2 && n <= 4) return 'сотрудника';
  return 'сотрудников';
}
