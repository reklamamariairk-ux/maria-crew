import { Bot, session, BotError } from 'grammy';
import type { BotContext, SessionData } from './context';
import { authMiddleware } from './middleware/auth';
import { handleStart, handleStoreSelection, mainMenuKeyboard } from './commands/start';
import { handleCollection } from './commands/collection';
import { handleCoins } from './commands/coins';
import { handleRating } from './commands/rating';
import { handleTop } from './commands/top';
import { handleStore, handleStoreCallback } from './commands/store';
import { handleCrew } from './commands/crew';

export function createBot(token: string): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  bot.use(session({ initial: (): SessionData => ({ step: 'idle' }) }));
  bot.use(authMiddleware);

  // Команды
  bot.command('start',      handleStart);
  bot.command('collection', handleCollection);
  bot.command('coins',      handleCoins);
  bot.command('rating',     handleRating);
  bot.command('top',        handleTop);
  bot.command('store',      handleStore);
  bot.command('crew',       handleCrew);

  // Регистрация — выбор точки
  bot.callbackQuery(/^reg:store:/, handleStoreSelection);

  // Главное меню — кнопки
  bot.callbackQuery('menu:collection', async ctx => {
    await ctx.answerCallbackQuery();
    await handleCollection(ctx);
  });
  bot.callbackQuery('menu:coins', async ctx => {
    await ctx.answerCallbackQuery();
    await handleCoins(ctx);
  });
  bot.callbackQuery('menu:rating', async ctx => {
    await ctx.answerCallbackQuery();
    await handleRating(ctx);
  });
  bot.callbackQuery('menu:top', async ctx => {
    await ctx.answerCallbackQuery();
    await handleTop(ctx);
  });
  bot.callbackQuery('menu:store', async ctx => {
    await ctx.answerCallbackQuery();
    await handleStore(ctx);
  });
  bot.callbackQuery('menu:crew', async ctx => {
    await ctx.answerCallbackQuery();
    await handleCrew(ctx);
  });
  bot.callbackQuery('menu:main', async ctx => {
    if (!ctx.employee) { await ctx.answerCallbackQuery(); return; }
    try {
      await ctx.editMessageText(
        `👋 Привет, <b>${ctx.employee.name}</b>! Выбери раздел:`,
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
      );
    } catch {
      await ctx.reply(
        `👋 Привет, <b>${ctx.employee.name}</b>! Выбери раздел:`,
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
      );
    }
    await ctx.answerCallbackQuery();
  });

  // Магазин
  bot.callbackQuery(/^store:/, handleStoreCallback);

  // Глобальный обработчик ошибок — ВСЕГДА отвечает пользователю
  bot.catch(async (err: BotError<BotContext>) => {
    const ctx = err.ctx;
    const e = err.error;
    console.error(`[bot] Ошибка в update ${ctx.update.update_id}:`, e);

    try {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery('Произошла ошибка, попробуй снова').catch(() => {});
      }
      await ctx.reply(
        '⚠️ Произошла ошибка. Попробуй снова или отправь /start'
      ).catch(() => {});
    } catch {
      // ignore reply errors
    }
  });

  return bot;
}
