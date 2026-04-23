import { InlineKeyboard } from 'grammy';
import { pool } from '../../db/pool';
import type { BotContext } from '../context';
import { esc } from '../helpers';

async function getStoresKeyboard(): Promise<InlineKeyboard> {
  const { rows } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM stores WHERE is_active = true ORDER BY id`
  );
  const kb = new InlineKeyboard();
  rows.forEach((s, i) => {
    kb.text(s.name, `reg:store:${s.id}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  return kb;
}

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

  ctx.session.step = 'waiting_name';
  await ctx.reply(
    '👋 Добро пожаловать в <b>Maria Crew</b>!\n\n' +
    'Это программа мотивации для сотрудников кондитерских «Мария».\n\n' +
    'Введи своё имя и фамилию:',
    { parse_mode: 'HTML' }
  );
}

export async function handleTextInput(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  if (ctx.session.step === 'waiting_name') {
    if (text.length < 2) {
      await ctx.reply('Имя слишком короткое. Попробуй ещё раз:');
      return;
    }
    ctx.session.pendingName = text;
    ctx.session.step = 'selecting_store';

    const kb = await getStoresKeyboard();
    await ctx.reply(
      `Отлично, <b>${esc(text)}</b>! 🎉\n\nВыбери свою кондитерскую:`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  }
}

export async function handleStoreSelection(ctx: BotContext): Promise<void> {
  const match = ctx.callbackQuery?.data?.match(/^reg:store:(\d+)$/);
  if (!match) return;

  const storeId = parseInt(match[1], 10);
  const name = ctx.session.pendingName;

  if (!name || ctx.session.step !== 'selecting_store') {
    await ctx.answerCallbackQuery();
    return;
  }

  const telegramId = ctx.from!.id;

  // Проверяем, не зарегистрирован ли уже (race condition)
  const { rows: existing } = await pool.query(
    `SELECT id FROM employees WHERE telegram_id = $1`,
    [telegramId]
  );
  if (existing.length > 0) {
    await ctx.editMessageText('Ты уже зарегистрирован! Отправь /start');
    await ctx.answerCallbackQuery();
    return;
  }

  const { rows: storeRows } = await pool.query<{ name: string }>(
    `SELECT name FROM stores WHERE id = $1`,
    [storeId]
  );

  await pool.query(
    `INSERT INTO employees (telegram_id, name, store_id, joined_at)
     VALUES ($1, $2, $3, CURRENT_DATE)`,
    [telegramId, name, storeId]
  );

  ctx.session.step = 'idle';
  ctx.session.pendingName = undefined;

  await ctx.editMessageText(
    `✅ Готово! Ты теперь часть <b>Maria Crew</b>!\n\n` +
    `👤 Имя: <b>${esc(name)}</b>\n` +
    `🏪 Точка: <b>${esc(storeRows[0]?.name ?? '')}</b>\n\n` +
    `Собирай карточек 12 героев, копи монеты и попади в рейтинг!\n\n` +
    `/collection — коллекция · /coins — монеты · /rating — рейтинг`,
    { parse_mode: 'HTML' }
  );
  await ctx.answerCallbackQuery('Добро пожаловать! 🎉');
}
