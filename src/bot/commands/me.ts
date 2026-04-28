import { InlineKeyboard } from 'grammy';
import { pool } from '../../db/pool';
import { getBalance, getMonthlySummary } from '../../services/coin.service';
import { getAvailableCardCount } from '../../services/card.service';
import { getStreak } from '../../services/streak.service';
import { getEmployeeLeaderboard } from '../../services/rating.service';
import type { BotContext } from '../context';
import { requireAuth } from '../middleware/auth';
import { esc, currentPeriod, monthName } from '../helpers';
import { mainMenuKeyboard } from './start';

export async function handleMe(ctx: BotContext): Promise<void> {
  if (!(await requireAuth(ctx))) return;
  const employee = ctx.employee!;
  const { year, month } = currentPeriod();

  const [balance, monthly, cards, heroRows, streak, leaderboard, storeRows] = await Promise.all([
    getBalance(employee.id),
    getMonthlySummary(employee.id, year, month),
    getAvailableCardCount(employee.id),
    pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT ec.hero_id) AS count
       FROM employee_cards ec JOIN heroes h ON h.id = ec.hero_id
       WHERE ec.employee_id = $1 AND h.is_limited = false`,
      [employee.id]
    ),
    getStreak(employee.id),
    getEmployeeLeaderboard(employee.storeId, year, month),
    pool.query<{ name: string }>(`SELECT name FROM stores WHERE id = $1`, [employee.storeId]),
  ]);

  const uniqueHeroes = parseInt(heroRows.rows[0]?.count ?? '0', 10);
  const myRank = leaderboard.findIndex(r => r.employeeId === employee.id) + 1;
  const storeName = storeRows.rows[0]?.name ?? '—';

  const text =
    `👤 <b>${esc(employee.name)}</b>\n` +
    `🏪 ${esc(storeName)}\n\n` +
    `💰 Монет: <b>${balance}</b> · за ${monthName(month, true)}: +${monthly.earned}\n` +
    `🃏 Карточек: <b>${cards}</b> · героев: <b>${uniqueHeroes}/12</b>\n` +
    `🔥 Серия: <b>${streak.currentStreak}</b> ${streak.checkedInToday ? '(сегодня отмечен ✅)' : '(не отмечен сегодня)'}\n` +
    (myRank > 0 ? `⭐ В рейтинге точки: <b>${myRank} место</b>\n` : '') +
    `\nОткрой Mini App кнопкой ниже для полной картины.`;

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() });
}
