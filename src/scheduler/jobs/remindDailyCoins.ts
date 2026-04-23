import { pool } from '../../db/pool';

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
    `SELECT e.telegram_id AS "telegramId", e.store_id AS "storeId", s.name AS "storeName"
     FROM employees e
     JOIN stores s ON s.id = e.store_id
     WHERE e.role IN ('manager', 'admin')
       AND e.is_active = true
       AND e.telegram_id IS NOT NULL`
  );

  if (managers.length === 0) return;

  // Для каждой точки — сколько сотрудников ещё не получили монету за чек-лист сегодня
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const notified: string[] = [];

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
             AND ct.created_at::date = $2::date
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

    await sendMessage(manager.telegramId, text).catch(() => {});
    notified.push(manager.telegramId);
  }

  if (notified.length > 0) {
    console.log(`[scheduler] remindDailyCoins: отправлено ${notified.length} напоминаний`);
  }
}

function empWord(n: number): string {
  if (n === 1) return 'сотрудник';
  if (n >= 2 && n <= 4) return 'сотрудника';
  return 'сотрудников';
}
