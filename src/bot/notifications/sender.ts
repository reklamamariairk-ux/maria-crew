import type { Bot } from 'grammy';
import { pool } from '../../db/pool';
import type { BotContext } from '../context';
import { esc, monthName, coinReasonLabel, cardSourceLabel } from '../helpers';
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

/** Получает telegram_id сотрудника по его id */
async function getEmployeeTelegramId(employeeId: number): Promise<string | null> {
  const { rows } = await pool.query<{ telegramId: string }>(
    `SELECT telegram_id::text AS "telegramId" FROM employees
     WHERE id = $1 AND telegram_id IS NOT NULL AND is_active = true`,
    [employeeId]
  );
  return rows[0]?.telegramId ?? null;
}

/** Уведомление о начислении/списании монет */
export async function notifyCoinAward(
  employeeId: number,
  amount: number,
  reason: string,
  note?: string
): Promise<void> {
  const tgId = await getEmployeeTelegramId(employeeId);
  if (!tgId) return;
  const label = coinReasonLabel(reason);
  const isPositive = amount > 0;
  const sign = isPositive ? '+' : '';
  const emoji = isPositive ? '💰' : '➖';
  const suffix = note ? `\n<i>${esc(note)}</i>` : '';
  const text = `${emoji} <b>${sign}${amount} ${coinWord(Math.abs(amount))}</b>\n${esc(label)}${suffix}`;
  await send(tgId, text);
}

/** Уведомление о выдаче карточки вручную или за метрики */
export async function notifyCardAward(
  employeeId: number,
  heroName: string,
  source: string,
  isMvp: boolean
): Promise<void> {
  const tgId = await getEmployeeTelegramId(employeeId);
  if (!tgId) return;
  const sourceLabel = cardSourceLabel(source);
  const mvpTag = isMvp ? ' ⭐' : '';
  const text =
    `🃏 <b>Новая карточка${mvpTag}</b>\n` +
    `Герой: <b>${esc(heroName)}</b>\n` +
    `За что: ${esc(sourceLabel)}\n\n` +
    `Открой приложение Maria Crew, чтобы увидеть коллекцию.`;
  await send(tgId, text);
}

/** Уведомление о подтверждённой/отклонённой заявке на обмен */
export async function notifyExchangeStatus(
  employeeId: number,
  prizeName: string,
  status: 'fulfilled' | 'rejected',
  notes?: string
): Promise<void> {
  const tgId = await getEmployeeTelegramId(employeeId);
  if (!tgId) return;
  if (status === 'fulfilled') {
    const text = `🎁 <b>Приз выдан!</b>\n«${esc(prizeName)}» — забирай у руководителя.`;
    await send(tgId, text);
  } else {
    const reason = notes ? `\n<i>Причина: ${esc(notes)}</i>` : '';
    const text = `❌ <b>Заявка отклонена</b>\nПриз: «${esc(prizeName)}». Карточки/монеты возвращены на баланс.${reason}`;
    await send(tgId, text);
  }
}

function coinWord(n: number): string {
  const abs = Math.abs(n);
  if (abs % 100 >= 11 && abs % 100 <= 19) return 'монет';
  if (abs % 10 === 1) return 'монета';
  if (abs % 10 >= 2 && abs % 10 <= 4) return 'монеты';
  return 'монет';
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

/** Уведомляет менеджеров точки и всех админов о новой заявке на обмен */
export async function notifyAdminNewExchange(
  employeeId: number,
  exchangeId: number
): Promise<void> {
  const { rows } = await pool.query<{
    employeeName: string;
    storeName: string;
    storeId: number;
    prizeName: string;
    cardsSpent: number;
    coinsSpent: number;
  }>(
    `SELECT
       e.name           AS "employeeName",
       s.name           AS "storeName",
       e.store_id       AS "storeId",
       p.name           AS "prizeName",
       se.cards_spent   AS "cardsSpent",
       se.coins_spent   AS "coinsSpent"
     FROM store_exchanges se
     JOIN employees e  ON e.id  = se.employee_id
     JOIN stores    s  ON s.id  = e.store_id
     JOIN prizes    p  ON p.id  = se.prize_id
     WHERE se.id = $1`,
    [exchangeId]
  );
  if (!rows[0]) return;

  const { employeeName, storeName, storeId, prizeName, cardsSpent, coinsSpent } = rows[0];

  const costParts: string[] = [];
  if (cardsSpent > 0) costParts.push(`${cardsSpent} карт.`);
  if (coinsSpent  > 0) costParts.push(`${coinsSpent} монет`);
  const cost = costParts.length ? ` (${costParts.join(' / ')})` : '';

  const text =
    `🔔 <b>Новая заявка на приз</b>\n` +
    `Сотрудник: <b>${esc(employeeName)}</b>\n` +
    `Точка: ${esc(storeName)}\n` +
    `Приз: «${esc(prizeName)}»${cost}`;

  const { rows: admins } = await pool.query<{ telegramId: string }>(
    `SELECT DISTINCT telegram_id::text AS "telegramId"
     FROM employees
     WHERE is_active = true
       AND telegram_id IS NOT NULL
       AND (
         (store_id = $1 AND role = 'manager')
         OR role = 'admin'
       )`,
    [storeId]
  );

  await Promise.allSettled(admins.map(a => send(a.telegramId, text)));
}

/** Массовая рассылка произвольного сообщения списку telegram_id */
export async function sendBroadcast(
  telegramIds: string[],
  message: string
): Promise<{ sent: number; failed: number }> {
  if (!_bot) return { sent: 0, failed: telegramIds.length };
  const results = await Promise.allSettled(
    telegramIds.map(tgId => _bot!.api.sendMessage(tgId, message))
  );
  const sent   = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  return { sent, failed };
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
