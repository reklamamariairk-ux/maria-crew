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
import { uploadFileFromUrl, isCloudinaryConfigured } from './cloudinary.service';
import type { CloudinaryResource } from './cloudinary.service';
import { sendPushToEmployee } from './push.service';

const BOT_TOKEN = (process.env.BOT_TOKEN ?? '').trim();

// Кэшированный bot для dispatch. Инициализируется в index.ts после createBot.
let _bot: Bot<BotContext> | null = null;
export function initRequestService(bot: Bot<BotContext>): void {
  _bot = bot;
}

export interface CreateRequestInput {
  requestedBy: number;
  /** Канонический способ — список ID сотрудников-получателей. */
  targetEmployeeIds?: number[];
  /** Back-compat: одиночный получатель. */
  targetEmployeeId?: number;
  /** Back-compat: вся точка (все активные сотрудники на момент создания). */
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
  /** Количество получателей (из request_targets) — для отображения «N сотрудников». */
  targetCount: number;
  /** Имена первых 3 получателей — для краткого превью в списке. */
  targetNames: string[];
  /** Число непрочитанных ответов сотрудников — для badge на строке. */
  unreadCount: number;
  /** Время последней активности — для сортировки. */
  lastActivityAt: string;
}

export interface RequestResponseRow {
  id: number;
  employeeId: number;
  employeeName: string;
  senderType: 'employee' | 'manager';
  adminUsername: string | null; // только для sender_type='manager'
  textContent: string | null;
  fileUrl: string | null;
  fileThumbnailUrl: string | null;
  fileType: 'photo' | 'video' | 'document' | null;
  fileName: string | null;
  createdAt: string;
}

export async function createRequest(input: CreateRequestInput): Promise<number> {
  const text = (input.requestText ?? '').trim();
  if (!text) throw new Error('requestText обязателен');

  // Резолвим финальный список получателей.
  let employeeIds: number[] = [];
  if (input.targetEmployeeIds && input.targetEmployeeIds.length > 0) {
    employeeIds = [...new Set(input.targetEmployeeIds)]; // dedup
  } else if (input.targetEmployeeId) {
    employeeIds = [input.targetEmployeeId];
  } else if (input.targetStoreId) {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM employees WHERE store_id = $1 AND is_active = true`,
      [input.targetStoreId]
    );
    employeeIds = rows.map(r => r.id);
  }
  if (employeeIds.length === 0) {
    throw new Error('Нужны targetEmployeeIds (или targetEmployeeId/targetStoreId)');
  }

  // Display hints — для удобства списка в админке:
  // - если 1 получатель → пишем target_employee_id (показывается как имя)
  // - если несколько и все из одной точки И это все активные точки →
  //   пишем target_store_id (показывается как имя точки)
  // - иначе оба NULL (отрисуется «N сотрудников»)
  let displayEmployeeId: number | null = null;
  let displayStoreId: number | null = null;
  if (employeeIds.length === 1) {
    displayEmployeeId = employeeIds[0];
  } else if (input.targetStoreId) {
    displayStoreId = input.targetStoreId;
  } else {
    const { rows } = await pool.query<{ storeId: number | null; allCount: string; selCount: string }>(
      `SELECT store_id::int AS "storeId",
              COUNT(*) FILTER (WHERE is_active = true) AS "allCount",
              COUNT(*) FILTER (WHERE id = ANY($1::int[])) AS "selCount"
       FROM employees
       WHERE store_id IS NOT NULL
       GROUP BY store_id
       HAVING COUNT(*) FILTER (WHERE id = ANY($1::int[])) > 0`,
      [employeeIds]
    );
    if (rows.length === 1 && rows[0].storeId !== null
        && parseInt(rows[0].allCount, 10) === parseInt(rows[0].selCount, 10)
        && parseInt(rows[0].selCount, 10) === employeeIds.length) {
      displayStoreId = rows[0].storeId;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO employee_requests
         (requested_by, target_employee_id, target_store_id, request_text)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.requestedBy, displayEmployeeId, displayStoreId, text]
    );
    const id = rows[0].id;
    await client.query(
      `INSERT INTO request_targets (request_id, employee_id)
       SELECT $1, unnest($2::int[])
       ON CONFLICT DO NOTHING`,
      [id, employeeIds]
    );
    await client.query('COMMIT');
    return id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Получает список сотрудников-получателей для запроса из request_targets. */
async function getTargetEmployees(requestId: number): Promise<Array<{
  id: number;
  name: string;
  telegramId: string | null;
}>> {
  const { rows } = await pool.query<{
    id: number; name: string; telegramId: string | null;
  }>(
    `SELECT e.id, e.name, e.telegram_id AS "telegramId"
     FROM request_targets rt
     JOIN employees e ON e.id = rt.employee_id
     WHERE rt.request_id = $1 AND e.is_active = true`,
    [requestId]
  );
  return rows;
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
export type AttachmentKind = 'photo' | 'video' | 'document';

export async function handleEmployeeReply(opts: {
  chatId: number;
  replyToMessageId: number | null;
  employeeId: number;
  text?: string | null;
  /** file_id из Telegram. fileKind определяет cloudinary endpoint и file_type в БД. */
  fileId?: string | null;
  fileKind?: AttachmentKind | null;
  /** Только для document — оригинальное имя файла из TG (если есть). */
  fileName?: string | null;
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

  // Если есть файл — заливаем в Cloudinary.
  let fileUrl: string | null = null;
  let fileThumb: string | null = null;
  let fileType: AttachmentKind | null = null;
  if (opts.fileId && opts.fileKind) {
    if (!BOT_TOKEN) throw new Error('BOT_TOKEN не задан');
    if (!isCloudinaryConfigured()) {
      throw new Error('Cloudinary не настроен — файл не сохранить');
    }
    const fileInfoRes = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(opts.fileId)}`
    );
    const fileInfo = await fileInfoRes.json() as { ok: boolean; result?: { file_path?: string } };
    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      throw new Error('getFile вернул ошибку');
    }
    const tgFileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
    const resource: CloudinaryResource =
      opts.fileKind === 'photo' ? 'image' :
      opts.fileKind === 'video' ? 'video' : 'raw';
    const uploaded = await uploadFileFromUrl(tgFileUrl, resource);
    fileUrl = uploaded.url;
    fileThumb = uploaded.thumbnailUrl;
    fileType = opts.fileKind;
  }

  const textContent = (opts.text ?? '').trim() || null;
  if (!textContent && !fileUrl) return null; // Пустой reply — ничего не сохраняем.

  await pool.query(
    `INSERT INTO request_responses
       (request_id, employee_id, sender_type, text_content, file_url, file_thumbnail_url, file_type, file_name, telegram_message_id)
     VALUES ($1, $2, 'employee', $3, $4, $5, $6, $7, $8)`,
    [requestId, opts.employeeId, textContent, fileUrl, fileThumb, fileType, opts.fileName ?? null, opts.messageId]
  );

  // Уведомляем владельца в TG что ответ пришёл (асинхронно, чтобы не блокировать).
  notifyOwnerOfResponse(requestId, opts.employeeId, textContent, fileType).catch(err => {
    console.warn('[request reply] не уведомили владельца:', err);
  });

  // Chat-mode: статус НЕ меняем автоматически. Запрос остаётся 'open'
  // пока менеджер вручную не закроет, чтобы можно было продолжать диалог.
  await pool.query(
    `UPDATE employee_requests SET updated_at = now() WHERE id = $1`,
    [requestId]
  );

  return { requestId };
}

/** Менеджер шлёт сообщение в существующий запрос. Создаёт response с
 *  sender_type='manager' и DM сотрудникам с пометкой «Сообщение от менеджера». */
export async function sendManagerMessage(opts: {
  requestId: number;
  text: string;
  adminUserId?: number;
}): Promise<{ recipientsCount: number; responseId: number }> {
  if (!_bot) throw new Error('request.service: bot не инициализирован');
  const text = (opts.text ?? '').trim();
  if (!text) throw new Error('Текст обязателен');

  // Берём первого target — для UI-чата это «адресат». Если запрос на
  // несколько сотрудников, шлём всем активным.
  const targets = await getTargetEmployees(opts.requestId);
  if (targets.length === 0) throw new Error('У запроса нет получателей');

  // Записываем сообщение в БД (employee_id = первого target, для записи).
  const { rows: insRows } = await pool.query<{ id: number }>(
    `INSERT INTO request_responses (request_id, employee_id, sender_type, admin_user_id, text_content)
     VALUES ($1, $2, 'manager', $3, $4) RETURNING id`,
    [opts.requestId, targets[0].id, opts.adminUserId ?? null, text]
  );

  // Рассылаем DM каждому получателю. Связываем reply→этот же запрос
  // через request_notifications (новое сообщение → новый message_id).
  const escText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dmHtml =
    `💬 <b>Сообщение от руководителя</b>\n\n` +
    `${escText}\n\n` +
    `<i>Ответь любым сообщением — попадёт в этот же диалог.</i>`;

  // Превью текста для пуша/уведомления
  const preview = text.length > 100 ? text.slice(0, 100) + '…' : text;

  let sent = 0;
  for (const emp of targets) {
    // TG DM (если есть привязка)
    if (emp.telegramId) {
      try {
        const msg = await _bot.api.sendMessage(emp.telegramId, dmHtml, { parse_mode: 'HTML' });
        await pool.query(
          `INSERT INTO request_notifications
             (request_id, employee_id, telegram_message_id, telegram_chat_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (request_id, employee_id) DO UPDATE SET
             telegram_message_id = EXCLUDED.telegram_message_id,
             telegram_chat_id    = EXCLUDED.telegram_chat_id,
             sent_at             = now()`,
          [opts.requestId, emp.id, msg.message_id, msg.chat.id]
        );
        sent++;
      } catch (err) {
        console.warn(`[request msg] TG не отправлено employee ${emp.id}:`, (err as Error).message);
      }
    }
    // FCM push (APK / standalone) — параллельно с TG
    sendPushToEmployee(emp.id, {
      title: '💬 Сообщение от руководителя',
      body: preview,
      data: { type: 'request_message', requestId: String(opts.requestId) },
    }).catch(err => console.warn(`[request msg] push не отправлен employee ${emp.id}:`, err));
  }

  // Менеджер написал в запрос — значит диалог активен. Если был closed,
  // переоткрываем (chat-mode: writes from manager re-open the thread).
  await pool.query(
    `UPDATE employee_requests SET
       status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
       updated_at = now(),
       last_viewed_at = now()
     WHERE id = $1`,
    [opts.requestId]
  );

  return { recipientsCount: sent, responseId: insRows[0].id };
}

/** Сколько запросов имеют ответ свежее last_viewed_at (или never-viewed с ответами). */
export async function getUnreadRequestCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(DISTINCT r.id)::int AS n
     FROM employee_requests r
     JOIN request_responses rr ON rr.request_id = r.id
     WHERE r.status <> 'closed'
       AND rr.sender_type = 'employee'
       AND (r.last_viewed_at IS NULL OR rr.created_at > r.last_viewed_at)`
  );
  return rows[0]?.n ?? 0;
}

/** Помечает запрос как просмотренный (для badge). */
export async function markRequestViewed(id: number): Promise<void> {
  await pool.query(
    `UPDATE employee_requests SET last_viewed_at = now() WHERE id = $1`,
    [id]
  );
}

/** Шлёт DM владельцу (OWNER_TELEGRAM_ID) о новом ответе на запрос. */
async function notifyOwnerOfResponse(
  requestId: number,
  employeeId: number,
  text: string | null,
  fileType: AttachmentKind | null
): Promise<void> {
  const ownerId = (process.env.OWNER_TELEGRAM_ID ?? '').trim();
  if (!ownerId || !_bot) return;
  const { rows } = await pool.query<{ employeeName: string; requestText: string }>(
    `SELECT e.name AS "employeeName", r.request_text AS "requestText"
     FROM employee_requests r
     JOIN employees e ON e.id = $2
     WHERE r.id = $1`,
    [requestId, employeeId]
  );
  if (!rows[0]) return;
  const fileLabel =
    fileType === 'photo' ? '📷 фото' :
    fileType === 'video' ? '🎬 видео' :
    fileType === 'document' ? '📎 файл' : '';
  const preview =
    text ? `«${text.slice(0, 100)}${text.length > 100 ? '…' : ''}»` :
    fileLabel ? fileLabel : '(пусто)';
  const escName = rows[0].employeeName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escReqText = rows[0].requestText.slice(0, 80).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html =
    `📨 <b>Ответ на запрос #${requestId}</b>\n\n` +
    `От: <b>${escName}</b>\n` +
    `Запрос: <i>${escReqText}${rows[0].requestText.length > 80 ? '…' : ''}</i>\n` +
    `Ответ: ${preview}\n\n` +
    `Открыть в админке: https://crew.145-223-121-47.sslip.io/`;
  await _bot.api.sendMessage(ownerId, html, { parse_mode: 'HTML' }).catch(() => {});
}

export async function listRequests(filter?: { status?: string }): Promise<RequestSummary[]> {
  const params: (string | null)[] = [filter?.status ?? null];
  const { rows } = await pool.query<RequestSummary & { targetNames: string[] | null }>(
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
            (SELECT COUNT(*)::int FROM request_notifications WHERE request_id = r.id) AS "notificationsSent",
            (SELECT COUNT(*)::int FROM request_targets WHERE request_id = r.id) AS "targetCount",
            (SELECT array_agg(e.name ORDER BY e.name)
             FROM (
               SELECT e.name FROM request_targets rt
               JOIN employees e ON e.id = rt.employee_id
               WHERE rt.request_id = r.id ORDER BY e.name LIMIT 3
             ) e) AS "targetNames",
            -- Непрочитанные ответы сотрудников после last_viewed_at (или все если ни разу не смотрели)
            (SELECT COUNT(*)::int FROM request_responses rr
              WHERE rr.request_id = r.id
                AND rr.sender_type = 'employee'
                AND (r.last_viewed_at IS NULL OR rr.created_at > r.last_viewed_at)
            ) AS "unreadCount",
            -- Время последней активности — max(updated_at, last response.created_at)
            GREATEST(r.updated_at, COALESCE(
              (SELECT MAX(created_at) FROM request_responses WHERE request_id = r.id),
              r.updated_at
            )) AS "lastActivityAt"
     FROM employee_requests r
     LEFT JOIN employees te ON te.id = r.target_employee_id
     LEFT JOIN stores s     ON s.id  = r.target_store_id
     WHERE ($1::text IS NULL OR r.status = $1)
     ORDER BY
       -- Сначала запросы с непрочитанными ответами (как в мессенджере)
       (CASE WHEN (
         SELECT COUNT(*) FROM request_responses rr
         WHERE rr.request_id = r.id
           AND rr.sender_type = 'employee'
           AND (r.last_viewed_at IS NULL OR rr.created_at > r.last_viewed_at)
       ) > 0 THEN 0 ELSE 1 END),
       -- Потом по времени последней активности
       GREATEST(r.updated_at, COALESCE(
         (SELECT MAX(created_at) FROM request_responses WHERE request_id = r.id),
         r.updated_at
       )) DESC
     LIMIT 200`,
    params
  );
  return rows.map(r => ({ ...r, targetNames: r.targetNames ?? [] }));
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
            rr.sender_type          AS "senderType",
            au.username             AS "adminUsername",
            rr.text_content         AS "textContent",
            rr.file_url             AS "fileUrl",
            rr.file_thumbnail_url   AS "fileThumbnailUrl",
            rr.file_type            AS "fileType",
            rr.file_name            AS "fileName",
            rr.created_at           AS "createdAt"
     FROM request_responses rr
     JOIN employees e ON e.id = rr.employee_id
     LEFT JOIN admin_users au ON au.id = rr.admin_user_id
     WHERE rr.request_id = $1
     ORDER BY rr.created_at`,
    [id]
  );
  return { request, responses };
}

/** Cron-job: шлёт напоминание сотрудникам которые получили запрос ≥ 2 часов
 *  назад и ещё не ответили. Шлёт один раз — `reminder_sent_at` помечается
 *  чтобы не спамить. Возвращает сколько напоминаний отправлено. */
export async function remindUnansweredRequests(): Promise<{ sent: number; skipped: number }> {
  if (!_bot) throw new Error('request.service: bot не инициализирован');

  // Ищем notifications где:
  //  - прошло >= 2 часа с момента отправки
  //  - напоминания ещё не было
  //  - сам запрос ещё открыт (не closed)
  //  - этот сотрудник ещё не отвечал на этот запрос
  const { rows: outstanding } = await pool.query<{
    notificationId: number;
    requestId: number;
    employeeId: number;
    telegramChatId: string;
    employeeName: string;
    requestText: string;
  }>(
    `SELECT n.id                      AS "notificationId",
            n.request_id              AS "requestId",
            n.employee_id             AS "employeeId",
            n.telegram_chat_id::text  AS "telegramChatId",
            e.name                    AS "employeeName",
            r.request_text            AS "requestText"
     FROM request_notifications n
     JOIN employee_requests r ON r.id = n.request_id
     JOIN employees e         ON e.id = n.employee_id
     WHERE n.reminder_sent_at IS NULL
       AND n.sent_at < now() - interval '2 hours'
       AND r.status <> 'closed'
       AND NOT EXISTS (
         SELECT 1 FROM request_responses rr
         WHERE rr.request_id = n.request_id AND rr.employee_id = n.employee_id
       )
     ORDER BY n.sent_at
     LIMIT 50`
  );

  let sent = 0, skipped = 0;
  for (const o of outstanding) {
    const escText = o.requestText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const dm =
      `⏰ <b>Напоминание</b>\n\n` +
      `Руководитель ждёт твой ответ на запрос:\n\n` +
      `${escText}\n\n` +
      `<i>Пришли фото или текст в ответ.</i>`;
    try {
      await _bot.api.sendMessage(o.telegramChatId, dm, { parse_mode: 'HTML' });
      await pool.query(
        `UPDATE request_notifications SET reminder_sent_at = now() WHERE id = $1`,
        [o.notificationId]
      );
      sent++;
    } catch (err) {
      // Пользователь заблокировал бота / прочее — помечаем чтобы не повторять.
      await pool.query(
        `UPDATE request_notifications SET reminder_sent_at = now() WHERE id = $1`,
        [o.notificationId]
      );
      console.warn(`[remind] не отправлено employee ${o.employeeId} (req ${o.requestId}):`, (err as Error).message);
      skipped++;
    }
  }
  return { sent, skipped };
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

/** Полное удаление запроса с каскадом (responses, notifications, targets). */
export async function deleteRequest(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM employee_requests WHERE id = $1`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}
