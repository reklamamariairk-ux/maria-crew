import { Bot, session, BotError } from 'grammy';
import type { BotContext, SessionData } from './context';
import { authMiddleware } from './middleware/auth';
import { handleStart, handleStoreSelection, mainMenuKeyboard } from './commands/start';
import { esc } from './helpers';
import { handleCollection } from './commands/collection';
import { handleCoins } from './commands/coins';
import { handleRating } from './commands/rating';
import { handleTop } from './commands/top';
import { handleStore, handleStoreCallback } from './commands/store';
import { handleCrew } from './commands/crew';
import { markBotError, markUpdate } from '../diagnostics';

export function createBot(token: string): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  // ── Базовые middleware (порядок важен) ────────────────────────────────────────
  bot.use(session({ initial: (): SessionData => ({ step: 'idle' }) }));

  // Диагностика — записывает каждый update
  bot.use(async (ctx, next) => {
    markUpdate({
      updateId: ctx.update.update_id,
      fromId:   ctx.from?.id,
      chatId:   ctx.chat?.id,
      text:     ctx.msg?.text,
    });
    await next();
  });

  // Авторизация — должна быть ДО всех команд, чтобы ctx.employee был заполнен
  bot.use(authMiddleware);

  // ── Диагностика ───────────────────────────────────────────────────────────────
  bot.command('ping', async ctx => {
    console.log(`[ping] from ${ctx.from?.id} @${ctx.from?.username}`);
    if (!ctx.chat?.id) return;
    await ctx.api.sendMessage(ctx.chat.id, '🏓 Pong! Бот работает.');
  });

  // ── Команды ───────────────────────────────────────────────────────────────────
  bot.command('start',      handleStart);
  bot.command('collection', handleCollection);
  bot.command('coins',      handleCoins);
  bot.command('rating',     handleRating);
  bot.command('top',        handleTop);
  bot.command('store',      handleStore);
  bot.command('crew',       handleCrew);

  // ── Регистрация (обратная совместимость с inline-кнопками выбора точки) ───────
  bot.callbackQuery(/^reg:store:/, handleStoreSelection);

  // ── Главное меню ──────────────────────────────────────────────────────────────
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
    const text = `👋 Привет, <b>${esc(ctx.employee.name)}</b>! Выбери раздел:`;
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() });
    }
    await ctx.answerCallbackQuery();
  });

  // ── Магазин ───────────────────────────────────────────────────────────────────
  bot.callbackQuery(/^store:/, handleStoreCallback);

  // ── Глобальный обработчик ошибок ──────────────────────────────────────────────
  bot.catch(async (err: BotError<BotContext>) => {
    const ctx = err.ctx;
    console.error(`[bot] Ошибка update#${ctx.update.update_id}:`, err.error);
    markBotError(err.error instanceof Error ? err.error.message : String(err.error));
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery('Ошибка, попробуй снова').catch(() => {});
      }
      await ctx.reply('⚠️ Произошла ошибка. Попробуй ещё раз или отправь /start').catch(() => {});
    } catch { /* ignore */ }
  });

  return bot;
}
