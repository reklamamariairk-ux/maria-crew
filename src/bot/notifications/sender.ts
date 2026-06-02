import type { Bot } from 'grammy';
import { pool } from '../../db/pool';
import type { BotContext } from '../context';
import { esc, monthName, coinReasonLabel, cardSourceLabel } from '../helpers';
import type { ProcessMonthResult } from '../../types';
import { sendPushToEmployee } from '../../services/push.service';
import { saveNotification } from '../../services/notification.service';

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

/** Telegram-id всех активных менеджеров/админов — получатели заявок на призы
 *  и сообщений сотрудников. Шлём всем, а не менеджеру конкретной точки: из 18
 *  точек менеджер привязан лишь к одной (Офис), иначе заявки/сообщения с
 *  остальных 17 точек не уведомляли никого. */
async function getManagerTelegramIds(): Promise<string[]> {
  const { rows } = await pool.query<{ telegramId: string }>(
    `SELECT DISTINCT telegram_id::text AS "telegramId"
       FROM employees
      WHERE is_active = true
        AND telegram_id IS NOT NULL
        AND role IN ('manager', 'admin')`
  );
  return rows.map(r => r.telegramId);
}

/** Рассылает HTML-уведомление всем менеджерам/админам (через send → с parse_mode). */
export async function notifyAllManagers(html: string): Promise<void> {
  const ids = await getManagerTelegramIds();
  await Promise.allSettled(ids.map(id => send(id, html)));
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

/** Уведомление о начислении/списании монет — Telegram + push мобилки */
export async function notifyCoinAward(
  employeeId: number,
  amount: number,
  reason: string,
  note?: string
): Promise<void> {
  const label = coinReasonLabel(reason);
  const isPositive = amount > 0;
  const sign = isPositive ? '+' : '';
  const emoji = isPositive ? '💰' : '➖';
  const suffix = note ? `\n<i>${esc(note)}</i>` : '';

  // Telegram (если привязан и активен)
  const tgId = await getEmployeeTelegramId(employeeId);
  if (tgId) {
    const text = `${emoji} <b>${sign}${amount} ${coinWord(Math.abs(amount))}</b>\n${esc(label)}${suffix}`;
    await send(tgId, text);
  }

  // Push в мобильное приложение (если зарегистрировано устройство)
  await sendPushToEmployee(employeeId, {
    title: `${emoji} ${sign}${amount} ${coinWord(Math.abs(amount))}`,
    body: note ? `${label} · ${note}` : label,
    data: { type: 'coin_award', amount: String(amount), reason },
  }).catch(() => { /* push не критичен */ });

  // Сохраняем в inbox (колокольчик в приложении)
  await saveNotification(employeeId, {
    type: 'coin_award',
    title: `${emoji} ${sign}${amount} ${coinWord(Math.abs(amount))}`,
    body: note ? `${label} · ${note}` : label,
    data: { amount, reason, note: note ?? null },
  });
}

/** Уведомление о выдаче карточки вручную или за метрики — Telegram + push */
export async function notifyCardAward(
  employeeId: number,
  heroName: string,
  source: string,
  isMvp: boolean
): Promise<void> {
  const sourceLabel = cardSourceLabel(source);
  const mvpTag = isMvp ? ' ⭐' : '';

  const tgId = await getEmployeeTelegramId(employeeId);
  if (tgId) {
    const text =
      `🃏 <b>Новая карточка${mvpTag}</b>\n` +
      `Герой: <b>${esc(heroName)}</b>\n` +
      `За что: ${esc(sourceLabel)}\n\n` +
      `Открой приложение Maria Crew, чтобы увидеть коллекцию.`;
    await send(tgId, text);
  }

  await sendPushToEmployee(employeeId, {
    title: `🃏 Новая карточка${mvpTag}`,
    body: `${heroName} · ${sourceLabel}`,
    data: { type: 'card_award', heroName, source, isMvp: String(isMvp) },
  }).catch(() => {});

  await saveNotification(employeeId, {
    type: 'card_award',
    title: `🃏 Новая карточка${mvpTag}`,
    body: `${heroName} · ${sourceLabel}`,
    data: { heroName, source, isMvp },
  });
}

/** Уведомление о подтверждённой/отклонённой заявке на обмен */
export async function notifyExchangeStatus(
  employeeId: number,
  prizeName: string,
  status: 'fulfilled' | 'rejected',
  notes?: string
): Promise<void> {
  const isFulfilled = status === 'fulfilled';
  const reasonSuffix = !isFulfilled && notes ? `\nПричина: ${notes}` : '';

  const title = isFulfilled
    ? '🎁 Приз выдан!'
    : '❌ Заявка отклонена';
  const body = isFulfilled
    ? `«${prizeName}» — забирай у руководителя.`
    : `Приз: «${prizeName}». Карточки и монеты возвращены на баланс.${reasonSuffix}`;

  // Telegram (если привязан)
  const tgId = await getEmployeeTelegramId(employeeId);
  if (tgId) {
    const escNotes = notes ? `\n<i>Причина: ${esc(notes)}</i>` : '';
    const text = isFulfilled
      ? `🎁 <b>Приз выдан!</b>\n«${esc(prizeName)}» — забирай у руководителя.`
      : `❌ <b>Заявка отклонена</b>\nПриз: «${esc(prizeName)}». Карточки и монеты возвращены на баланс.${escNotes}`;
    await send(tgId, text);
  }

  // Push в мобилку
  await sendPushToEmployee(employeeId, {
    title,
    body,
    data: { type: 'exchange', status, prizeName },
  }).catch(() => {});

  // Inbox (колокольчик в приложении) — работает даже если нет Telegram-привязки
  await saveNotification(employeeId, {
    type: 'exchange',
    title,
    body,
    data: { status, prizeName, notes: notes ?? null },
  });
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

/** Уведомляет лучшего сотрудника точки */
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
    `⭐ <b>Ты лучший сотрудник точки!</b>\n\n` +
    `${esc(storeName)} · ${monthName(month)} ${year}\n` +
    `Результат: <b>${score.toFixed(2)} баллов</b>\n\n` +
    `Твои призы:\n` +
    `🃏 Особая карточка героя\n` +
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
    `🏆 <b>Ваша точка — лучшая в этом месяце!</b>\n\n` +
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
       COALESCE(p.name, se.prize_name) AS "prizeName",
       se.cards_spent   AS "cardsSpent",
       se.coins_spent   AS "coinsSpent"
     FROM store_exchanges se
     JOIN employees e  ON e.id  = se.employee_id
     JOIN stores    s  ON s.id  = e.store_id
     LEFT JOIN prizes p  ON p.id  = se.prize_id
     WHERE se.id = $1`,
    [exchangeId]
  );
  if (!rows[0]) return;

  const { employeeName, storeName, prizeName, cardsSpent, coinsSpent } = rows[0];

  const costParts: string[] = [];
  if (cardsSpent > 0) costParts.push(`${cardsSpent} карт.`);
  if (coinsSpent  > 0) costParts.push(`${coinsSpent} монет`);
  const cost = costParts.length ? ` (${costParts.join(' / ')})` : '';

  const text =
    `🔔 <b>Новая заявка на приз</b>\n` +
    `Сотрудник: <b>${esc(employeeName)}</b>\n` +
    `Точка: ${esc(storeName)}\n` +
    `Приз: «${esc(prizeName)}»${cost}`;

  // Шлём всем активным менеджерам/админам (см. getManagerTelegramIds).
  const recipientIds = await getManagerTelegramIds();
  await Promise.allSettled(recipientIds.map(id => send(id, text)));
}

/** Отправить алерт владельцу системы (в Telegram).
 *  Используется при критических ошибках: упал cron, бот выкинул unhandled error,
 *  миграция не применилась.
 *
 *  Чтобы алерты приходили — задай ENV OWNER_TELEGRAM_ID (число — ID владельца
 *  в Telegram). Узнать его можно через @userinfobot.
 *
 *  Защита от спама: дедупликация по тексту сообщения за 1 час. */
const _alertHistory = new Map<string, number>();
export async function alertOwner(message: string, throttleMs = 60 * 60 * 1000): Promise<void> {
  if (!_bot) return;
  const ownerId = process.env.OWNER_TELEGRAM_ID;
  if (!ownerId) return; // не настроен — тихо игнорируем

  const now = Date.now();
  const last = _alertHistory.get(message);
  if (last && now - last < throttleMs) return; // дедупликация
  _alertHistory.set(message, now);

  // Чистка старых записей чтобы Map не рос бесконечно
  if (_alertHistory.size > 100) {
    for (const [k, t] of _alertHistory.entries()) {
      if (now - t > throttleMs * 2) _alertHistory.delete(k);
    }
  }

  try {
    const text = `🚨 <b>Maria Crew Alert</b>\n\n${message}\n\n<i>${new Date().toLocaleString('ru')}</i>`;
    await _bot.api.sendMessage(ownerId, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[alertOwner] failed to send:', err instanceof Error ? err.message : err);
  }
}

/**
 * Уведомляет руководителей точки и владельца о новой регистрации сотрудника
 * через мобильное приложение. Помогает быстро заметить мошенника / опечатку.
 */
export async function notifyManagersOfNewEmployee(
  employeeId: number,
  storeId: number,
): Promise<void> {
  if (!_bot) return;
  try {
    const { rows } = await pool.query<{
      employeeName: string; storeName: string;
      managerTelegramIds: string[];
    }>(
      `SELECT e.name AS "employeeName",
              s.name AS "storeName",
              COALESCE(
                (SELECT array_agg(m.telegram_id::text)
                 FROM employees m
                 WHERE m.store_id = $2 AND m.role = 'manager'
                   AND m.is_active = true AND m.telegram_id IS NOT NULL),
                ARRAY[]::text[]
              ) AS "managerTelegramIds"
       FROM employees e
       LEFT JOIN stores s ON s.id = $2
       WHERE e.id = $1`,
      [employeeId, storeId]
    );
    const r = rows[0];
    if (!r) return;

    const text =
      `👋 <b>Новая регистрация в Maria Crew</b>\n\n` +
      `Сотрудник: <b>${esc(r.employeeName)}</b>\n` +
      `Точка: ${esc(r.storeName ?? '—')}\n\n` +
      `Если этот человек тебе незнаком — деактивируй его в админке: ` +
      `https://crew.145-223-121-47.sslip.io/admin (вкладка Сотрудники).`;

    // Менеджерам точки
    for (const tgId of r.managerTelegramIds ?? []) {
      try { await _bot.api.sendMessage(tgId, text, { parse_mode: 'HTML' }); }
      catch { /* пользователь заблокировал бота — пропускаем */ }
    }
    // Владелец (OWNER_TELEGRAM_ID) — всегда
    const ownerId = process.env.OWNER_TELEGRAM_ID;
    if (ownerId) {
      try { await _bot.api.sendMessage(ownerId, text, { parse_mode: 'HTML' }); }
      catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[notifyManagers] failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Отправляет PIN-код для входа в мобильное приложение.
 * PIN форматируется в крупные цифры — чтобы было видно в нотификации Telegram.
 */
export async function sendLoginPin(telegramId: string, pin: string): Promise<boolean> {
  if (!_bot) return false;
  const text = `🔐 <b>Код для входа в мобильное приложение Maria Crew</b>\n\n` +
               `<code>${pin}</code>\n\n` +
               `Действует <b>10 минут</b>. Никому не сообщай этот код.\n` +
               `Если ты не запрашивал — просто проигнорируй это сообщение.`;
  try {
    await _bot.api.sendMessage(telegramId, text, { parse_mode: 'HTML' });
    return true;
  } catch (err) {
    console.error('[sendLoginPin] failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Массовая рассылка произвольного сообщения списку telegram_id.
 *  Ограничение Telegram: ~30 msg/sec для бота. Поэтому шлём батчами по 25
 *  с паузой 1.1 сек между батчами — иначе при 200+ получателях большая
 *  часть упадёт с 429 (rate limit). */
export async function sendBroadcast(
  telegramIds: string[],
  message: string,
  options?: { parseMode?: 'HTML' }
): Promise<{ sent: number; failed: number }> {
  if (!_bot) return { sent: 0, failed: telegramIds.length };
  const BATCH = 25;
  const PAUSE_MS = 1100;
  // По умолчанию plain text (для /api/notify). HTML-вызовы передают parseMode явно.
  const sendOpts = options?.parseMode ? { parse_mode: options.parseMode } : undefined;

  let sent = 0, failed = 0;
  for (let i = 0; i < telegramIds.length; i += BATCH) {
    const batch = telegramIds.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(tgId => _bot!.api.sendMessage(tgId, message, sendOpts))
    );
    sent   += results.filter(r => r.status === 'fulfilled').length;
    failed += results.filter(r => r.status === 'rejected').length;
    if (i + BATCH < telegramIds.length) {
      await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
    }
  }
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
    text += `🏆 <b>Лучшая точка: ${esc(storeName)}</b> — ${top.storeScore.toFixed(1)} баллов\n\n`;
  }

  text += `<b>Лучшие сотрудники по точкам:</b>\n`;
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
