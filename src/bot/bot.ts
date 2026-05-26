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
import { handleEmployeeReply } from '../services/request.service';

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
      // Нормализуем номер к формату +XXXXXXXXXXX (Telegram иногда без плюса)
      const phoneNorm = contact.phone_number.startsWith('+')
        ? contact.phone_number
        : `+${contact.phone_number}`;

      // Проверяем что сотрудник вообще зарегистрирован
      const { rows: emp } = await pool.query<{ phone: string | null }>(
        `SELECT phone FROM employees WHERE telegram_id = $1 AND is_active = true`,
        [tgId]
      );
      if (!emp[0]) {
        await ctx.reply(
          'Сначала пройди регистрацию — отправь /start и выбери свою точку.',
          { reply_markup: { remove_keyboard: true } }
        );
        return;
      }

      // Уже есть номер? Не перезаписываем — телефон в 1С менять только через админку
      if (emp[0].phone && emp[0].phone.trim()) {
        await ctx.reply(
          'Номер уже сохранён ранее. Если нужно изменить — обратись к руководителю.',
          { reply_markup: { remove_keyboard: true } }
        );
        return;
      }

      await pool.query(
        `UPDATE employees SET phone = $1 WHERE telegram_id = $2`,
        [phoneNorm, tgId]
      );
      await ctx.reply('✅ Номер сохранён, спасибо!', {
        reply_markup: { remove_keyboard: true },
      });
    } catch (err) {
      console.error('[contact] save error:', err);
      await ctx.reply('Не удалось сохранить номер, попробуй позже.');
    }
  });

  // ── Ответ сотрудника на запрос менеджера (reply на сообщение бота) ──────────
  // Срабатывает только когда есть reply_to_message и сотрудник в БД.
  // Внутри request.service ищем привязку по chat_id+reply_to_message_id.
  bot.on('message', async (ctx, next) => {
    const reply = ctx.message.reply_to_message;
    if (!reply) { return next(); }
    if (!ctx.employee) { return next(); }
    if (!ctx.chat?.id) { return next(); }

    // Берём самое большое фото (последнее в массиве PhotoSize).
    const photo = ctx.message.photo;
    const photoFileId = photo && photo.length > 0 ? photo[photo.length - 1].file_id : null;
    const text = ctx.message.text ?? ctx.message.caption ?? null;
    if (!photoFileId && !text) { return next(); }

    try {
      const res = await handleEmployeeReply({
        chatId: ctx.chat.id,
        replyToMessageId: reply.message_id,
        employeeId: ctx.employee.id,
        text,
        photoFileId,
        messageId: ctx.message.message_id,
      });
      if (res) {
        await ctx.reply('✅ Ответ принят, спасибо!');
      } else {
        // Не наш запрос — пропускаем дальше (вдруг это другой handler нужен).
        return next();
      }
    } catch (err) {
      console.error('[request reply] обработка не удалась:', err);
      await ctx.reply('⚠️ Не удалось сохранить ответ. Попробуй ещё раз или напиши руководителю.');
    }
  });

  // ── Глобальный обработчик ошибок ──────────────────────────────────────────────
  bot.catch(async (err: BotError<BotContext>) => {
    const ctx = err.ctx;
    const msg = err.error instanceof Error ? err.error.message : String(err.error);
    console.error(`[bot] Ошибка update#${ctx.update.update_id}:`, err.error);
    markBotError(msg);
    // Алерт владельцу — но throttle 1 час чтобы не заспамить если ошибка
    // повторяется при каждом сообщении
    try {
      const { alertOwner } = await import('./notifications/sender');
      alertOwner(`Bot error: ${msg}\nUpdate: #${ctx.update.update_id}, from ${ctx.from?.id}`).catch(() => {});
    } catch { /* ignore */ }
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery('Ошибка, попробуй снова').catch(() => {});
      }
      await ctx.reply('⚠️ Произошла ошибка. Попробуй ещё раз или отправь /start').catch(() => {});
    } catch { /* ignore */ }
  });

  return bot;
}
