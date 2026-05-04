import { InlineKeyboard } from 'grammy';
import { getEmployeeLeaderboard } from '../../services/rating.service';
import type { BotContext } from '../context';
import { requireAuth } from '../middleware/auth';
import { rankEmoji, monthName, currentPeriod, esc } from '../helpers';

export async function handleRating(ctx: BotContext): Promise<void> {
  if (!(await requireAuth(ctx))) return;
  const employee = ctx.employee!;

  const { year, month } = currentPeriod();
  const leaderboard = await getEmployeeLeaderboard(employee.storeId, year, month);

  const kb = new InlineKeyboard().text('🏆 Лучшие точки', 'menu:top').text('← Меню', 'menu:main');

  const scored   = leaderboard.filter(e => e.mvpScore !== null);
  const unscored = leaderboard.filter(e => e.mvpScore === null);

  // Никого с оценкой — рейтинг ещё не сформирован
  if (scored.length === 0) {
    await ctx.reply(
      `📊 Рейтинг за ${monthName(month, true)} ещё не сформирован.\n` +
      `Баллы появятся, когда руководитель внесёт показатели или нажмёт «Обработать месяц».`,
      { reply_markup: kb }
    );
    return;
  }

  const monthLabel = `${monthName(month)} ${year}`;
  let text = `📊 <b>Рейтинг точки — ${monthLabel}</b>\n\n`;

  let myRank = 0;
  scored.forEach((entry, i) => {
    const rank = i + 1;
    const emoji = rankEmoji(rank);
    const mvpTag = entry.isMvp ? ' ⭐ Лучший' : '';
    const score = entry.mvpScore!.toFixed(2);
    text += `${emoji} ${esc(entry.name)} — ${score}${mvpTag}\n`;

    if (entry.employeeId === employee.id) myRank = rank;
  });

  if (unscored.length > 0) {
    text += `\n<b>Без оценки:</b> ${unscored.map(e => esc(e.name)).join(', ')}\n`;
  }

  if (myRank > 0) {
    const myEntry = scored[myRank - 1];
    const score = myEntry.mvpScore!.toFixed(2);
    text += `\n▶ <b>Ты на ${myRank} месте — ${score} баллов</b>`;
    if (myEntry.isMvp) text += ' 🏆';
  } else if (unscored.some(e => e.employeeId === employee.id)) {
    text += `\n▶ <i>У тебя пока нет оценки за этот месяц.</i>`;
  }

  text += `\n\n<i>Рейтинг обновляется после обработки месяца.</i>`;

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}
