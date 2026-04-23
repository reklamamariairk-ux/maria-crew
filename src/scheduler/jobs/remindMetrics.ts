import { pool } from '../../db/pool';
import { monthName } from '../../bot/helpers';

/**
 * Запускается 1-го числа каждого месяца в 10:00.
 * Напоминает руководителям ввести метрики за прошедший месяц.
 */
export async function remindMetrics(
  sendMessage: (telegramId: string, html: string) => Promise<void>
): Promise<void> {
  const now = new Date();
  // Прошлый месяц
  const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  const prevYear  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  // Находим всех менеджеров с telegram_id
  const { rows: managers } = await pool.query<{
    telegramId: string; name: string; storeName: string;
  }>(
    `SELECT e.telegram_id AS "telegramId", e.name, s.name AS "storeName"
     FROM employees e
     JOIN stores s ON s.id = e.store_id
     WHERE e.role IN ('manager', 'admin')
       AND e.is_active = true
       AND e.telegram_id IS NOT NULL`
  );

  if (managers.length === 0) return;

  const text =
    `📋 <b>Напоминание: введите метрики за ${monthName(prevMonth, true)} ${prevYear}</b>\n\n` +
    `Не забудьте заполнить показатели по каждому сотруднику:\n` +
    `• Балл тайного покупателя\n` +
    `• Количество именных отзывов\n` +
    `• Процент выполнения чек-листа\n` +
    `• Процент выполнения плана выручки\n\n` +
    `После заполнения нажмите <b>«Обработать месяц»</b> в Admin Panel — ` +
    `бот автоматически раздаст карточки и уведомит команду.\n\n` +
    `<i>Срок: до 5-го числа.</i>`;

  await Promise.allSettled(
    managers.map(m => sendMessage(m.telegramId, text))
  );

  console.log(`[scheduler] remindMetrics: отправлено ${managers.length} напоминаний`);
}
