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

  // Показываем только точки с уже выставленным баллом — без баллов сортировка
  // не имеет смысла для рейтинга
  const ranked = ranking.filter(s => s.totalScore !== null);
  if (ranked.length === 0) {
    await ctx.reply(
      `🏆 Рейтинг точек за ${monthName(month, true)} ещё не сформирован.\n` +
      `Результаты появятся когда руководитель введёт показатели.`,
      { reply_markup: kb }
    );
    return;
  }

  let myStoreRank = 0;
  ranked.forEach((store, i) => {
    const rank = i + 1;
    const emoji = rankEmoji(rank);
    const topTag = store.isTop ? ' ⭐ ТОП' : '';
    const score = Number(store.totalScore).toFixed(1);
    text += `${emoji} ${esc(store.storeName)} — ${score}${topTag}\n`;

    if (store.storeId === employee.storeId) myStoreRank = rank;
  });

  if (myStoreRank > 0) {
    const myStore = ranked.find(s => s.storeId === employee.storeId);
    text += `\n▶ <b>Твоя точка на ${myStoreRank} месте</b>`;
    if (myStore?.isTop) text += ' 🎉 Топ-точка! Всем +1 карточка!';
  } else {
    text += `\n▶ Твоя точка пока не оценена за этот месяц.`;
  }

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}
