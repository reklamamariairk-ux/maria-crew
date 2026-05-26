// Запросы менеджеров к сотрудникам.
// См. migrations/045_employee_requests.sql.
//
// Flow:
//  1. Админ через /api/requests создаёт запрос (target = employee_id ИЛИ store_id).
//  2. dispatchRequest(bot, id) рассылает DM всем target-сотрудникам и
//     записывает каждое сообщение в request_notifications (для reply_to lookup).
//  3. Сотрудник делает Reply на сообщение бота (текст или фото).
//     handleEmployeeReply ищет в request_notifications по reply_to_message_id
//     → находит request_id → создаёт request_responses (фото грузится в Cloudinary).
//  4. После первого ответа на single-employee запрос — auto-close.

import type { Bot } from 'grammy';
import type { BotContext } from '../bot/context';
import { pool } from '../db/pool';
import { uploadImageFromUrl, isCloudinaryConfigured } from './cloudinary.service';

const BOT_TOKEN = (process.env.BOT_TOKEN ?? '').trim();

// Кэшированный bot для dispatch. Инициализируется в index.ts после createBot.
let _bot: Bot<BotContext> | null = null;
export function initRequestService(bot: Bot<BotContext>): void {
  _bot = bot;
}

export interface CreateRequestInput {
  requestedBy: number;
  targetEmployeeId?: number;
  targetStoreId?: number;
  requestText: string;
}

export interface RequestSummary {
  id: number;
  requestedBy: number;
  targetEmployeeId: number | null;
  targetEmployeeName: string | null;
  targetStoreId: number | null;
  targetStoreName: string | null;
  requestText: string;
  status: 'open' | 'answered' | 'closed';
  createdAt: string;
  updatedAt: string;
  responseCount: number;
  notificationsSent: number;
}

export interface RequestResponseRow {
  id: number;
  employeeId: number;
  employeeName: string;
  textContent: string | null;
  photoUrl: string | null;
  photoThumbnailUrl: string | null;
  createdAt: string;
}

export async function createRequest(input: CreateRequestInput): Promise<number> {
  const text = (input.requestText ?? '').trim();
  if (!text) throw new Error('requestText обязателен');
  if (!input.targetEmployeeId && !input.targetStoreId) {
    throw new Error('Нужен либо targetEmployeeId, либо targetStoreId');
  }
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO employee_requests
       (requested_by, target_employee_id, target_store_id, request_text)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.requestedBy, input.targetEmployeeId ?? null, input.targetStoreId ?? null, text]
  );
  return rows[0].id;
}

/** Получает список сотрудников-получателей для запроса. */
async function getTargetEmployees(requestId: number): Promise<Array<{
  id: number;
  name: string;
  telegramId: string | null;
}>> {
  const { rows } = await pool.query<{
    targetEmployeeId: number | null;
    targetStoreId: number | null;
  }>(
    `SELECT target_employee_id AS "targetEmployeeId", target_store_id AS "targetStoreId"
     FROM employee_requests WHERE id = $1`,
    [requestId]
  );
  if (!rows[0]) throw new Error('Запрос не найден');
  const { targetEmployeeId, targetStoreId } = rows[0];

  if (targetEmployeeId) {
    const { rows: emp } = await pool.query<{
      id: number; name: string; telegramId: string | null;
    }>(
      `SELECT id, name, telegram_id AS "telegramId"
       FROM employees WHERE id = $1 AND is_active = true`,
      [targetEmployeeId]
    );
    return emp;
  }
  // По точке — все активные сотрудники с привязанным Telegram.
  const { rows: emps } = await pool.query<{
    id: number; name: string; telegramId: string | null;
  }>(
    `SELECT id, name, telegram_id AS "telegramId"
     FROM employees
     WHERE store_id = $1 AND is_active = true AND telegram_id IS NOT NULL`,
    [targetStoreId]
  );
  return emps;
}

/** Рассылает запрос в Telegram. Каждое сообщение фиксирует в request_notifications. */
export async function dispatchRequest(
  requestId: number
): Promise<{ sent: number; skipped: number }> {
  if (!_bot) throw new Error('request.service: bot не инициализирован');
  const { rows: reqRows } = await pool.query<{ requestText: string }>(
    `SELECT request_text AS "requestText" FROM employee_requests WHERE id = $1`,
    [requestId]
  );
  if (!reqRows[0]) throw new Error('Запрос не найден');
  const text = reqRows[0].requestText;

  const targets = await getTargetEmployees(requestId);
  let sent = 0, skipped = 0;

  // Экранирование HTML — простое для текста запроса (только &<>).
  const escText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dmHtml =
    `📋 <b>Запрос от руководителя</b>\n\n` +
    `${escText}\n\n` +
    `<i>Ответь на это сообщение — текстом или фото.</i>`;

  for (const emp of targets) {
    if (!emp.telegramId) { skipped++; continue; }
    try {
      const sentMsg = await _bot.api.sendMessage(emp.telegramId, dmHtml, { parse_mode: 'HTML' });
      await pool.query(
        `INSERT INTO request_notifications
           (request_id, employee_id, telegram_message_id, telegram_chat_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (request_id, employee_id) DO UPDATE SET
           telegram_message_id = EXCLUDED.telegram_message_id,
           telegram_chat_id    = EXCLUDED.telegram_chat_id,
           sent_at             = now()`,
        [requestId, emp.id, sentMsg.message_id, sentMsg.chat.id]
      );
      sent++;
    } catch (err) {
      // Пользователь заблокировал бота / нет TG / прочее — не падаем
      console.warn(`[request ${requestId}] не отправлено employee ${emp.id}:`, (err as Error).message);
      skipped++;
    }
  }
  return { sent, skipped };
}

/** Обработка входящего ответа сотрудника. Вернёт request_id если ответ привязан.
 *  Стратегия поиска запроса:
 *    1. Если у сообщения есть reply_to_message — пробуем точный матч по
 *       (chat_id, message_id) в request_notifications.
 *    2. Если reply нет или не нашлось — fallback: берём самый свежий
 *       не-закрытый запрос для этого сотрудника. Reply в TG не интуитивно
 *       на мобильных, поэтому такой UX-fallback убирает один шаг для юзера. */
export async function handleEmployeeReply(opts: {
  chatId: number;
  replyToMessageId: number | null;
  employeeId: number;
  text?: string | null;
  photoFileId?: string | null;
  messageId: number;
}): Promise<{ requestId: number } | null> {
  let requestId: number | null = null;

  // Шаг 1: точный матч по reply_to_message_id (если reply есть).
  if (opts.replyToMessageId) {
    const { rows: notif } = await pool.query<{
      requestId: number; expectedEmployeeId: number;
    }>(
      `SELECT request_id AS "requestId", employee_id AS "expectedEmployeeId"
       FROM request_notifications
       WHERE telegram_chat_id = $1 AND telegram_message_id = $2`,
      [opts.chatId, opts.replyToMessageId]
    );
    if (notif[0] && notif[0].expectedEmployeeId === opts.employeeId) {
      requestId = notif[0].requestId;
    }
  }

  // Шаг 2: fallback — последний не-closed запрос для этого сотрудника.
  // Сюда же попадают случаи когда reply на бот-сообщение НЕ принадлежащее
  // запросу (например на /start или /coins) — тогда вернёт null если у
  // юзера нет активных запросов.
  if (!requestId) {
    const { rows: fallback } = await pool.query<{ requestId: number }>(
      `SELECT n.request_id AS "requestId"
       FROM request_notifications n
       JOIN employee_requests r ON r.id = n.request_id
       WHERE n.employee_id = $1
         AND n.telegram_chat_id = $2
         AND r.status <> 'closed'
       ORDER BY n.sent_at DESC
       LIMIT 1`,
      [opts.employeeId, opts.chatId]
    );
    if (fallback[0]) {
      requestId = fallback[0].requestId;
    }
  }

  if (!requestId) return null; // Не наш use-case — random message от сотрудника.

  // Если фото — заливаем в Cloudinary.
  let photoUrl: string | null = null;
  let photoThumb: string | null = null;
  if (opts.photoFileId) {
    if (!BOT_TOKEN) throw new Error('BOT_TOKEN не задан');
    if (!isCloudinaryConfigured()) {
      throw new Error('Cloudinary не настроен — фото не сохранить');
    }
    // Получаем file_path через bot API
    const fileInfoRes = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(opts.photoFileId)}`
    );
    const fileInfo = await fileInfoRes.json() as { ok: boolean; result?: { file_path?: string } };
    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      throw new Error('getFile вернул ошибку');
    }
    const tgFileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
    const uploaded = await uploadImageFromUrl(tgFileUrl);
    photoUrl = uploaded.url;
    photoThumb = uploaded.thumbnailUrl;
  }

  const textContent = (opts.text ?? '').trim() || null;
  if (!textContent && !photoUrl) return null; // Пустой reply — ничего не сохраняем.

  await pool.query(
    `INSERT INTO request_responses
       (request_id, employee_id, text_content, photo_url, photo_thumbnail_url, telegram_message_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [requestId, opts.employeeId, textContent, photoUrl, photoThumb, opts.messageId]
  );

  // Обновляем статус: для single-employee запроса auto-close → answered.
  // Для store-запроса (multi-target) оставляем open, чтобы пришли ответы от
  // остальных сотрудников; админ закроет вручную.
  await pool.query(
    `UPDATE employee_requests SET
       status = CASE
         WHEN target_employee_id IS NOT NULL THEN 'answered'
         ELSE status
       END,
       updated_at = now()
     WHERE id = $1`,
    [requestId]
  );

  return { requestId };
}

export async function listRequests(filter?: { status?: string }): Promise<RequestSummary[]> {
  const params: (string | null)[] = [filter?.status ?? null];
  const { rows } = await pool.query<RequestSummary>(
    `SELECT r.id,
            r.requested_by      AS "requestedBy",
            r.target_employee_id AS "targetEmployeeId",
            te.name             AS "targetEmployeeName",
            r.target_store_id   AS "targetStoreId",
            s.name              AS "targetStoreName",
            r.request_text      AS "requestText",
            r.status,
            r.created_at        AS "createdAt",
            r.updated_at        AS "updatedAt",
            (SELECT COUNT(*)::int FROM request_responses WHERE request_id = r.id) AS "responseCount",
            (SELECT COUNT(*)::int FROM request_notifications WHERE request_id = r.id) AS "notificationsSent"
     FROM employee_requests r
     LEFT JOIN employees te ON te.id = r.target_employee_id
     LEFT JOIN stores s     ON s.id  = r.target_store_id
     WHERE ($1::text IS NULL OR r.status = $1)
     ORDER BY r.created_at DESC
     LIMIT 200`,
    params
  );
  return rows;
}

export async function getRequest(id: number): Promise<{
  request: RequestSummary;
  responses: RequestResponseRow[];
} | null> {
  const list = await listRequests();
  const request = list.find(r => r.id === id);
  if (!request) return null;
  const { rows: responses } = await pool.query<RequestResponseRow>(
    `SELECT rr.id,
            rr.employee_id          AS "employeeId",
            e.name                  AS "employeeName",
            rr.text_content         AS "textContent",
            rr.photo_url            AS "photoUrl",
            rr.photo_thumbnail_url  AS "photoThumbnailUrl",
            rr.created_at           AS "createdAt"
     FROM request_responses rr
     JOIN employees e ON e.id = rr.employee_id
     WHERE rr.request_id = $1
     ORDER BY rr.created_at`,
    [id]
  );
  return { request, responses };
}

export async function closeRequest(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE employee_requests
        SET status = 'closed', updated_at = now()
      WHERE id = $1 AND status <> 'closed'`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}
