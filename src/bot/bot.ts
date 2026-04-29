import { Bot, session, BotError, Keyboard } from 'grammy';
import { pool } from '../db/pool';
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
import { handleMe } from './commands/me';
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
  bot.command('me',         handleMe);

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

  // ── Получение номера телефона (через "Поделиться контактом") ────────────────
  bot.on(':contact', async ctx => {
    const tgId = ctx.from?.id;
    const contact = ctx.message?.contact;
    if (!tgId || !contact) return;
    if (contact.user_id !== tgId) {
      await ctx.reply('Поделись, пожалуйста, своим собственным номером 🙂');
      return;
    }
    try {
      const { rowCount } = await pool.query(
        `UPDATE employees SET phone = $1
         WHERE telegram_id = $2 AND (phone IS NULL OR phone = '')`,
        [contact.phone_number, tgId]
      );
      if (rowCount && rowCount > 0) {
        await ctx.reply('✅ Номер сохранён, спасибо!', {
          reply_markup: { remove_keyboard: true },
        });
      } else {
        await ctx.reply('Номер уже сохранён ранее.', {
          reply_markup: { remove_keyboard: true },
        });
      }
    } catch (err) {
      console.error('[contact] save error:', err);
      await ctx.reply('Не удалось сохранить номер, попробуй позже.');
    }
  });

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
