import type { BotContext } from '../context';
import { esc } from '../helpers';

export async function handleStart(ctx: BotContext): Promise<void> {
  if (ctx.employee) {
    await ctx.reply(
      `Привет, <b>${esc(ctx.employee.name)}</b>! 👋\n\n` +
      `Ты часть <b>Maria Crew</b>. Что хочешь посмотреть?\n\n` +
      `/collection — моя коллекция карточек\n` +
      `/coins — баланс монет\n` +
      `/rating — рейтинг точки\n` +
      `/top — топ-точки сети\n` +
      `/store — Maria Store\n` +
      `/crew — коллекция команды`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const username = ctx.from?.username ? `@${ctx.from.username}` : 'неизвестен';
  await ctx.reply(
    `👋 Привет!\n\n` +
    `Тебя пока нет в системе <b>Maria Crew</b>.\n\n` +
    `Попроси своего руководителя добавить тебя — твой Telegram: <code>${esc(username)}</code>`,
    { parse_mode: 'HTML' }
  );
}
