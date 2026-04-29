import { InlineKeyboard, Keyboard } from 'grammy';
import { pool } from '../../db/pool';
import type { BotContext } from '../context';
import { esc } from '../helpers';

/** Если у сотрудника нет телефона — отправляет клавиатуру с кнопкой "Поделиться номером". */
async function maybeAskPhone(ctx: BotContext, employeeId: number): Promise<void> {
  const { rows } = await pool.query<{ phone: string | null }>(
    `SELECT phone FROM employees WHERE id = $1`, [employeeId]
  );
  if (rows[0]?.phone) return;
  const kb = new Keyboard().requestContact('📱 Поделиться номером').oneTime().resized();
  await ctx.reply(
    'Чтобы руководители могли быстрее с тобой связаться — поделись номером телефона:',
    { reply_markup: kb }
  );
}

const WEBAPP_URL = (
  process.env.WEBHOOK_URL ??
  process.env.RENDER_EXTERNAL_URL ??
  'https://maria-crew.onrender.com'
).replace(/\/$/, '') + '/webapp';

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .webApp('🚀 Открыть Maria Crew', WEBAPP_URL).row()
    .text('🃏 Коллекция', 'menu:collection').text('💰 Монеты', 'menu:coins').row()
    .text('⭐ Рейтинг', 'menu:rating').text('🏆 Топ точек', 'menu:top').row()
    .text('🛍 Maria Store', 'menu:store').text('👥 Команда', 'menu:crew');
}


export async function handleStart(ctx: BotContext): Promise<void> {
  console.log(`[start] user=${ctx.from?.id} username=${ctx.from?.username} employee=${!!ctx.employee}`);

  const send = async (text: string, reply_markup: InlineKeyboard) => {
    if (!ctx.chat?.id) return;
    await ctx.api.sendMessage(ctx.chat.id, text, {
      parse_mode: 'HTML',
      reply_markup,
    });
  };

  if (ctx.employee) {
    await send(
      `👋 Привет, <b>${esc(ctx.employee.name)}</b>!\n\n` +
      `Открывай приложение и смотри свои карточки, монеты и рейтинг:`,
      mainMenuKeyboard()
    );
    await maybeAskPhone(ctx, ctx.employee.id);
    return;
  }

  const kb = new InlineKeyboard().webApp('🚀 Открыть Maria Crew', WEBAPP_URL);

  await send(
    '🍰 <b>Добро пожаловать в Maria Crew!</b>\n\n' +
    'Программа мотивации для команды кондитерских «Мария».\n\n' +
    '<b>Как начать — 3 шага:</b>\n' +
    '1️⃣ Нажми кнопку <b>«Открыть Maria Crew»</b> ниже\n' +
    '2️⃣ Выбери свою кондитерскую из списка\n' +
    '3️⃣ Нажми <b>«Присоединиться к команде»</b>\n\n' +
    '🃏 Карточки героев — за работу и результат\n' +
    '💰 Монеты — за квиз, чек-листы и активность\n' +
    '🎁 Призы — торт, сертификаты, премия до 7 000 ₽\n\n' +
    '<i>Кнопка «🍰 Maria Crew» внизу экрана тоже открывает приложение</i>',
    kb
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

  // Запрашиваем номер у нового сотрудника
  const { rows: empRows } = await pool.query<{ id: number }>(
    `SELECT id FROM employees WHERE telegram_id = $1`, [telegramId]
  );
  if (empRows[0]) await maybeAskPhone(ctx, empRows[0].id);
}
