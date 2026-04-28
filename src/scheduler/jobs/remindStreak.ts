import { pool } from '../../db/pool';

/**
 * Личное напоминание сотрудникам с активной серией: «не теряй её».
 * Запускается в 21:00 Иркутск — ещё есть время отметиться.
 */
export async function remindStreak(
  sendMessage: (telegramId: string, html: string) => Promise<void>
): Promise<void> {
  // Иркутское «сегодня» — UTC+8
  const irkNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const today = irkNow.toISOString().slice(0, 10);
  const yesterday = new Date(irkNow.getTime() - 86_400_000).toISOString().slice(0, 10);

  // Кому уведомление: серия > 0 (отмечался вчера), не отмечался сегодня, есть telegram_id
  const { rows } = await pool.query<{
    telegramId: string; name: string; streakDay: number;
  }>(
    `SELECT e.telegram_id::text AS "telegramId", e.name,
            (SELECT streak_day FROM daily_checkins
             WHERE employee_id = e.id AND checkin_date = $2) AS "streakDay"
     FROM employees e
     WHERE e.is_active = true
       AND e.telegram_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM daily_checkins
         WHERE employee_id = e.id AND checkin_date = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM daily_checkins
         WHERE employee_id = e.id AND checkin_date = $1
       )`,
    [today, yesterday]
  );

  if (rows.length === 0) return;

  await Promise.allSettled(rows.map(r => {
    const day = r.streakDay ?? 0;
    const text =
      `🔥 <b>Не теряй серию!</b>\n\n` +
      `У тебя ${day} ${day % 10 === 1 && day % 100 !== 11 ? 'день' : (day % 10 >= 2 && day % 10 <= 4 && (day % 100 < 10 || day % 100 >= 20) ? 'дня' : 'дней')} подряд.\n` +
      `Зайди в Maria Crew и нажми 🔥 в шапке, пока день не закончился.`;
    return sendMessage(r.telegramId, text);
  }));

  console.log(`[scheduler] remindStreak: отправлено ${rows.length} напоминаний`);
}
