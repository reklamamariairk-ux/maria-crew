import { InlineKeyboard } from 'grammy';
import { getBalance, getHistory, getMonthlySummary, COIN_AMOUNTS } from '../../services/coin.service';
import type { BotContext } from '../context';
import { requireAuth } from '../middleware/auth';
import { coinReasonLabel, shortDate, currentPeriod, coinWord } from '../helpers';

export async function handleCoins(ctx: BotContext): Promise<void> {
  if (!(await requireAuth(ctx))) return;
  const employee = ctx.employee!;

  const { year, month } = currentPeriod();

  const [balance, history, monthly] = await Promise.all([
    getBalance(employee.id),
    getHistory(employee.id, 7),
    getMonthlySummary(employee.id, year, month),
  ]);

  let text =
    `💰 <b>Мария-монеты</b>\n\n` +
    `Баланс: <b>${balance} ${coinWord(balance)}</b>\n\n` +
    `За этот месяц: +${monthly.earned} заработано, −${monthly.spent} потрачено\n`;

  if (history.length > 0) {
    text += `\n<b>Последние операции:</b>\n`;
    for (const t of history) {
      const sign = t.amount > 0 ? '+' : '';
      const label = coinReasonLabel(t.reason);
      const date = shortDate(new Date(t.createdAt));
      text += `${sign}${t.amount} — ${label} · <i>${date}</i>\n`;
    }
  }

  text += `\n<b>Как заработать монеты:</b>\n`;
  text += `+${COIN_AMOUNTS.quiz} — каждый правильный ответ в квизе (до +${COIN_AMOUNTS.quiz * 5}/день)\n`;
  text += `+${COIN_AMOUNTS.checkin} — ежедневный вход (бонус +3 за каждый 7-й день подряд)\n`;
  text += `+${COIN_AMOUNTS.checklist_day} — чек-лист 100% за день\n`;
  text += `+${COIN_AMOUNTS.review} — именной отзыв гостя\n`;
  text += `+${COIN_AMOUNTS.substitution} — подмена коллеги\n`;
  text += `+${COIN_AMOUNTS.mentoring} — наставничество\n\n`;
  text += `Открой Mini App, чтобы пройти квиз и отметиться. Обменяй монеты в /store`;

  const kb = new InlineKeyboard().text('🛍 Maria Store', 'menu:store').text('← Меню', 'menu:main');
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}
