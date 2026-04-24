import { InlineKeyboard } from 'grammy';
import { getStoreLeaderboard } from '../../services/rating.service';
import type { BotContext } from '../context';
import { requireAuth } from '../middleware/auth';
import { rankEmoji, monthName, currentPeriod, esc } from '../helpers';

export async function handleTop(ctx: BotContext): Promise<void> {
  if (!(await requireAuth(ctx))) return;
  const employee = ctx.employee!;

  const { year, month } = currentPeriod();
  const ranking = await getStoreLeaderboard(year, month);

  const kb = new InlineKeyboard().text('⭐ Рейтинг точки', 'menu:rating').text('← Меню', 'menu:main');
  if (ranking.length === 0) {
    await ctx.reply(
      `🏆 Рейтинг точек за ${monthName(month, true)} ещё не сформирован.\n` +
      `Результаты появятся в начале следующего месяца.`,
      { reply_markup: kb }
    );
    return;
  }

  const monthLabel = `${monthName(month)} ${year}`;
  let text = `🏆 <b>Топ-точки — ${monthLabel}</b>\n\n`;

  let myStoreRank = 0;
  ranking.forEach(store => {
    const emoji = rankEmoji(store.rank);
    const topTag = store.isTop ? ' ⭐ ТОП' : '';
    const score = store.totalScore !== null ? Number(store.totalScore).toFixed(1) : '—';
    text += `${emoji} ${esc(store.storeName)} — ${score}${topTag}\n`;

    if (store.storeId === employee.storeId) myStoreRank = store.rank;
  });

  if (myStoreRank > 0) {
    const myStore = ranking.find(s => s.storeId === employee.storeId);
    text += `\n▶ <b>Твоя точка на ${myStoreRank} месте</b>`;
    if (myStore?.isTop) text += ' 🎉 Топ-точка! Всем +1 карточка!';
  }

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}
