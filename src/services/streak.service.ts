import { pool } from '../db/pool';
import { COIN_AMOUNTS } from './coin.service';

export interface StreakInfo {
  checkedInToday: boolean;
  currentStreak: number;
  lastCheckin: string | null;
}

/** YYYY-MM-DD по Иркутскому времени (UTC+8). Все сотрудники в Иркутске,
 *  «день» должен меняться в полночь Иркутска, а не UTC. */
export function irkutskDate(offsetDays = 0): string {
  const irk = new Date(Date.now() + (8 * 60 * 60 + offsetDays * 24 * 3600) * 1000);
  return irk.toISOString().slice(0, 10);
}

export async function getStreak(employeeId: number): Promise<StreakInfo> {
  const today = irkutskDate();

  const { rows } = await pool.query<{ checkinDate: string; streakDay: number }>(
    `SELECT checkin_date::text AS "checkinDate", streak_day AS "streakDay"
     FROM daily_checkins
     WHERE employee_id = $1
     ORDER BY checkin_date DESC
     LIMIT 2`,
    [employeeId]
  );

  const latest = rows[0];
  const checkedInToday = latest?.checkinDate === today;
  const currentStreak = latest?.streakDay ?? 0;

  return {
    checkedInToday,
    currentStreak,
    lastCheckin: latest?.checkinDate ?? null,
  };
}

export async function doCheckin(employeeId: number): Promise<{ streakDay: number; coinsEarned: number; alreadyCheckedIn: boolean }> {
  const today = irkutskDate();
  const yesterday = irkutskDate(-1);

  const { rows: prev } = await pool.query<{ streakDay: number }>(
    `SELECT streak_day AS "streakDay" FROM daily_checkins
     WHERE employee_id = $1 AND checkin_date = $2`,
    [employeeId, yesterday]
  );

  const streakDay = (prev[0]?.streakDay ?? 0) + 1;
  const isWeekly = streakDay % 7 === 0;
  const coinsEarned = isWeekly ? 20 : COIN_AMOUNTS.checkin;
  const note = isWeekly
    ? `🔥 Серия ${streakDay} дней! Недельный бонус`
    : `Ежедневный вход, серия ${streakDay} ${plural(streakDay, 'день', 'дня', 'дней')}`;

  // ON CONFLICT DO NOTHING защищает от двойного начисления при параллельных запросах
  const { rows: inserted } = await pool.query<{ id: number }>(
    `INSERT INTO daily_checkins (employee_id, checkin_date, streak_day, coins_earned)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_id, checkin_date) DO NOTHING
     RETURNING id`,
    [employeeId, today, streakDay, coinsEarned]
  );

  if (!inserted[0]) {
    return { streakDay: 0, coinsEarned: 0, alreadyCheckedIn: true };
  }

  await pool.query(
    `INSERT INTO coin_transactions (employee_id, amount, reason, note)
     VALUES ($1, $2, 'checkin', $3)`,
    [employeeId, coinsEarned, note]
  );

  return { streakDay, coinsEarned, alreadyCheckedIn: false };
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m100 >= 11 && m100 <= 19) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}
