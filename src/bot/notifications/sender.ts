import type { Bot } from 'grammy';
import { pool } from '../../db/pool';
import type { BotContext } from '../context';
import { esc, monthName } from '../helpers';
import type { ProcessMonthResult } from '../../types';

let _bot: Bot<BotContext> | null = null;

export function initNotifications(bot: Bot<BotContext>): void {
  _bot = bot;
}

async function send(telegramId: bigint | string, html: string): Promise<void> {
  if (!_bot) return;
  try {
    await _bot.api.sendMessage(String(telegramId), html, { parse_mode: 'HTML' });
  } catch {
    // Пользователь заблокировал бота — игнорируем
  }
}

/** Уведомляет одного сотрудника о полученных карточках */
export async function notifyCardsAwarded(
  employeeId: number,
  heroNames: string[],
  source: string
): Promise<void> {
  const { rows } = await pool.query<{ telegramId: bigint }>(
    `SELECT telegram_id AS "telegramId" FROM employees WHERE id = $1 AND telegram_id IS NOT NULL`,
    [employeeId]
  );
  if (!rows[0]) return;

  const list = heroNames.map(n => `🃏 <b>${esc(n)}</b>`).join('\n');
  const text =
    `🎉 <b>Новые карточки!</b>\n\n` +
    `${list}\n\n` +
    `Посмотри коллекцию: /collection`;

  await send(rows[0].telegramId, text);
}

/** Уведомляет MVP точки */
export async function notifyMvp(
  employeeId: number,
  storeName: string,
  month: number,
  year: number,
  score: number
): Promise<void> {
  const { rows } = await pool.query<{ telegramId: bigint }>(
    `SELECT telegram_id AS "telegramId" FROM employees WHERE id = $1 AND telegram_id IS NOT NULL`,
    [employeeId]
  );
  if (!rows[0]) return;

  const text =
    `⭐ <b>Ты MVP точки!</b>\n\n` +
    `${esc(storeName)} · ${monthName(month)} ${year}\n` +
    `Результат: <b>${score.toFixed(2)} баллов</b>\n\n` +
    `Твои призы:\n` +
    `🃏 Карточка героя с отметкой MVP\n` +
    `🎂 Торт или пирог «Мария» в подарок\n` +
    `📅 Право первого выбора смен\n\n` +
    `Так держать! 💪`;

  await send(rows[0].telegramId, text);
}

/** Уведомляет всю команду о победе в Топ-точке */
export async function notifyTopStore(
  storeId: number,
  storeName: string,
  month: number,
  year: number,
  score: number
): Promise<void> {
  const { rows } = await pool.query<{ telegramId: bigint }>(
    `SELECT e.telegram_id AS "telegramId"
     FROM employees e
     WHERE e.store_id = $1 AND e.is_active = true AND e.telegram_id IS NOT NULL`,
    [storeId]
  );

  const text =
    `🏆 <b>Ваша точка — Топ-точка месяца!</b>\n\n` +
    `${esc(storeName)} · ${monthName(month)} ${year}\n` +
    `Результат: <b>${score.toFixed(1)} баллов</b>\n\n` +
    `Каждый получает +1 карточку героя 🃏\n` +
    `Совместный обед на всю смену 🍕\n\n` +
    `Вы лучшие! 🎉`;

  await Promise.allSettled(rows.map(r => send(r.telegramId, text)));
}

/**
 * Публикует итоги месяца в канал «Maria Crew».
 * CREW_CHANNEL_ID должен быть задан в .env.
 */
export async function publishMonthResults(
  results: ProcessMonthResult[],
  month: number,
  year: number
): Promise<void> {
  if (!_bot || !process.env.CREW_CHANNEL_ID) return;

  const top = results.find(r => r.topStore);

  // Получаем имена точек и MVP
  const { rows: storeRows } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM stores WHERE id = ANY($1)`,
    [results.map(r => r.storeId)]
  );
  const storeMap = new Map(storeRows.map(s => [s.id, s.name]));

  let text = `📊 <b>Итоги ${monthName(month, true)} ${year}</b>\n\n`;

  if (top) {
    const storeName = storeMap.get(top.storeId) ?? '';
    text += `🏆 <b>Топ-точка: ${esc(storeName)}</b> — ${top.storeScore.toFixed(1)} баллов\n\n`;
  }

  text += `<b>MVP по точкам:</b>\n`;
  for (const result of results) {
    const mvp = result.employees.find(e => e.isMvp);
    if (mvp) {
      const storeName = storeMap.get(result.storeId) ?? '';
      text += `⭐ ${esc(storeName)}: <b>${esc(mvp.name)}</b> (${mvp.mvpScore.toFixed(2)} б.)\n`;
    }
  }

  text += `\nПосмотри свой рейтинг: /rating`;

  try {
    await _bot.api.sendMessage(process.env.CREW_CHANNEL_ID, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Ошибка публикации в канал:', err);
  }
}
