import { InlineKeyboard } from 'grammy';
import { pool } from '../../db/pool';
import type { BotContext } from '../context';
import { esc } from '../helpers';

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🃏 Коллекция', 'menu:collection').text('💰 Монеты', 'menu:coins').row()
    .text('⭐ Рейтинг', 'menu:rating').text('🏆 Топ точек', 'menu:top').row()
    .text('🛍 Maria Store', 'menu:store').text('👥 Команда', 'menu:crew');
}

async function getStoresKeyboard(): Promise<InlineKeyboard | null> {
  const { rows } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM stores WHERE is_active = true ORDER BY id`
  );
  if (rows.length === 0) return null;

  const kb = new InlineKeyboard();
  rows.forEach((s, i) => {
    kb.text(s.name, `reg:store:${s.id}`);
    // НЕ добавляем row() после последней кнопки — пустая строка ломает Telegram API
    if ((i + 1) % 2 === 0 && i < rows.length - 1) kb.row();
    else if ((i + 1) % 2 !== 0 && i === rows.length - 1) { /* нечётное кол-во — последняя одна */ }
  });
  return kb;
}

export async function handleStart(ctx: BotContext): Promise<void> {
  console.log(`[start] user=${ctx.from?.id} username=${ctx.from?.username} employee=${!!ctx.employee}`);

  if (ctx.employee) {
    await ctx.reply(
      `👋 Привет, <b>${esc(ctx.employee.name)}</b>!\n\n` +
      `Добро пожаловать в <b>Maria Crew</b> — выбери раздел:`,
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  let kb: InlineKeyboard | null = null;
  try {
    kb = await getStoresKeyboard();
  } catch (err) {
    console.error('[start] getStoresKeyboard error:', err);
  }

  if (!kb) {
    await ctx.reply(
      '👋 Добро пожаловать в <b>Maria Crew</b>!\n\n' +
      'Система ещё настраивается. Попробуй снова через минуту или обратись к руководителю.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await ctx.reply(
    '👋 Добро пожаловать в <b>Maria Crew</b>!\n\n' +
    'Программа мотивации сотрудников кондитерских «Мария».\n\n' +
    '🏪 Выбери свою кондитерскую:',
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

export async function handleStoreSelection(ctx: BotContext): Promise<void> {
  const match = ctx.callbackQuery?.data?.match(/^reg:store:(\d+)$/);
  if (!match) return;

  const storeId = parseInt(match[1], 10);
  const telegramId = ctx.from!.id;
  const username = ctx.from!.username?.toLowerCase() ?? null;
  const name = [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(' ') || 'Сотрудник';

  // Уже зарегистрирован — просто показываем меню
  if (ctx.employee) {
    try {
      await ctx.editMessageText(
        `👋 Привет, <b>${esc(ctx.employee.name)}</b>! Выбери раздел:`,
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
      );
    } catch {
      await ctx.reply(
        `👋 Привет, <b>${esc(ctx.employee.name)}</b>! Выбери раздел:`,
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
      );
    }
    await ctx.answerCallbackQuery();
    return;
  }

  const { rows: storeRows } = await pool.query<{ name: string }>(
    `SELECT name FROM stores WHERE id = $1`, [storeId]
  );
  if (!storeRows[0]) {
    await ctx.answerCallbackQuery('Точка не найдена');
    return;
  }

  let empName = name;

  if (username) {
    // Если менеджер заранее добавил сотрудника по username — привязываем
    const { rows: linked } = await pool.query<{ name: string }>(
      `UPDATE employees
       SET telegram_id = $1
       WHERE LOWER(telegram_username) = $2 AND telegram_id IS NULL AND is_active = true
       RETURNING name`,
      [telegramId, username]
    );
    if (linked.length > 0) {
      empName = linked[0].name;
    } else {
      // Создаём новую запись
      const { rows } = await pool.query<{ name: string }>(
        `INSERT INTO employees (telegram_id, telegram_username, name, store_id, joined_at)
         VALUES ($1, $2, $3, $4, CURRENT_DATE)
         ON CONFLICT (telegram_id) DO UPDATE SET store_id = EXCLUDED.store_id
         RETURNING name`,
        [telegramId, username, name, storeId]
      );
      empName = rows[0]?.name ?? name;
    }
  } else {
    const { rows } = await pool.query<{ name: string }>(
      `INSERT INTO employees (telegram_id, name, store_id, joined_at)
       VALUES ($1, $2, $3, CURRENT_DATE)
       ON CONFLICT (telegram_id) DO UPDATE SET store_id = EXCLUDED.store_id
       RETURNING name`,
      [telegramId, name, storeId]
    );
    empName = rows[0]?.name ?? name;
  }

  console.log(`[start] registered: telegramId=${telegramId} name=${empName} store=${storeId}`);

  try {
    await ctx.editMessageText(
      `✅ <b>Ты в команде Maria Crew!</b>\n\n` +
      `👤 <b>${esc(empName)}</b>\n` +
      `🏪 ${esc(storeRows[0].name)}\n\n` +
      `Собирай карточки героев, копи монеты и попади в рейтинг!`,
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
    );
  } catch {
    await ctx.reply(
      `✅ <b>Ты в команде Maria Crew!</b>\n\n` +
      `👤 <b>${esc(empName)}</b>\n` +
      `🏪 ${esc(storeRows[0].name)}\n\n` +
      `Собирай карточки героев, копи монеты и попади в рейтинг!`,
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
    );
  }
  await ctx.answerCallbackQuery('Добро пожаловать! 🎉');
}
