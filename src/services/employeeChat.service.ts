// Чат сотрудника со стороны Mini App / Capacitor APK.
//
// Симметрично admin'скому чату (request.service.sendManagerMessage),
// но с проверкой что сотрудник — реальный target запроса. Пишет
// response с sender_type='employee', обновляет request_employee_views
// (для unread badge на стороне сотрудника), и НЕ отвечает в TG —
// потому что сообщение приходит из приложения, не из TG-бота.
//
// Для тех сотрудников у кого есть TG-связка и они привыкли отвечать
// в TG — это работает параллельно через bot.on('message') →
// handleEmployeeReply (request.service).

import { pool } from '../db/pool';

export interface EmployeeRequestSummary {
  id: number;
  requestText: string;
  status: 'open' | 'closed';
  createdAt: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageSender: 'employee' | 'manager';
  unreadCount: number;
}

export interface EmployeeChatMessage {
  id: number;
  senderType: 'employee' | 'manager';
  adminUsername: string | null;
  textContent: string | null;
  fileUrl: string | null;
  fileThumbnailUrl: string | null;
  fileType: 'photo' | 'video' | 'document' | null;
  fileName: string | null;
  createdAt: string;
}

/** Сотрудник создаёт новый диалог с руководителем. Без target'ов, только
 *  initiated_by_employee_id = он сам. Админы увидят thread в общем списке. */
export async function createEmployeeInitiatedRequest(opts: {
  employeeId: number;
  text: string;
  fileUrl?: string | null;
  fileThumbnailUrl?: string | null;
  fileType?: 'photo' | 'video' | 'document' | null;
  fileName?: string | null;
}): Promise<{ requestId: number }> {
  const text = (opts.text ?? '').trim();
  if (!text && !opts.fileUrl) throw new Error('Нужен текст или файл');

  // Месенджер-логика: если у сотрудника уже есть open thread (где он target
  // ИЛИ инициатор) — пишем туда вместо создания нового. WhatsApp-стиль.
  const { rows: existing } = await pool.query<{ id: number }>(
    `SELECT r.id FROM employee_requests r
     LEFT JOIN request_targets rt ON rt.request_id = r.id AND rt.employee_id = $1
     WHERE r.status <> 'closed'
       AND (rt.employee_id = $1 OR r.initiated_by_employee_id = $1)
     ORDER BY r.updated_at DESC LIMIT 1`,
    [opts.employeeId]
  );
  if (existing[0]) {
    const res = await sendEmployeeMessage({
      requestId: existing[0].id,
      employeeId: opts.employeeId,
      text: text || null,
      fileUrl: opts.fileUrl ?? null,
      fileThumbnailUrl: opts.fileThumbnailUrl ?? null,
      fileType: opts.fileType ?? null,
      fileName: opts.fileName ?? null,
    });
    if (!res) throw new Error('Не удалось добавить сообщение в существующий чат');
    return { requestId: existing[0].id };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Сам запрос. request_text — это первое сообщение сотрудника (показывается
    // как первый bubble в чате). Targets пустые, initiated_by_employee_id заполнен.
    const { rows: reqRows } = await client.query<{ id: number }>(
      `INSERT INTO employee_requests
         (requested_by, request_text, initiated_by_employee_id, status)
       VALUES (NULL, $1, $2, 'open')
       RETURNING id`,
      [text || (opts.fileType ? `(вложение: ${opts.fileType})` : '—'), opts.employeeId]
    );
    const requestId = reqRows[0].id;

    // Сразу пишем первое сообщение в request_responses как сотрудник.
    // Это нужно чтобы в admin-thread первый bubble был от сотрудника, а не как
    // системный "request_text" (он же используется как мета-первое-сообщение).
    // Но чтобы избежать дубликата (request_text + response) — не дублируем,
    // используем только request_text для отображения. Сообщение само лежит там.
    if (opts.fileUrl) {
      // Если есть файл — дополнительно вставляем как response (request_text
      // не содержит файла, только текст). Файл будет первым messages-bubble.
      await client.query(
        `INSERT INTO request_responses
           (request_id, employee_id, sender_type, text_content, file_url,
            file_thumbnail_url, file_type, file_name)
         VALUES ($1, $2, 'employee', NULL, $3, $4, $5, $6)`,
        [requestId, opts.employeeId, opts.fileUrl, opts.fileThumbnailUrl ?? null,
         opts.fileType ?? null, opts.fileName ?? null]
      );
    }

    // Помечаем что сотрудник «прочитал» свой запрос (свои сообщения он же видит)
    await client.query(
      `INSERT INTO request_employee_views (request_id, employee_id, last_viewed_at)
       VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
      [requestId, opts.employeeId]
    );

    await client.query('COMMIT');
    return { requestId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Список запросов где сотрудник — получатель ИЛИ инициатор. Закрытые не показываем. */
export async function listEmployeeRequests(employeeId: number): Promise<EmployeeRequestSummary[]> {
  const { rows } = await pool.query<EmployeeRequestSummary & { lastMsgText: string | null; lastMsgFileType: string | null }>(
    `SELECT r.id,
            r.request_text AS "requestText",
            r.status,
            r.created_at   AS "createdAt",
            -- Время последней активности — max(updated_at, последнее сообщение)
            GREATEST(r.updated_at, COALESCE(
              (SELECT MAX(created_at) FROM request_responses WHERE request_id = r.id),
              r.updated_at
            )) AS "lastMessageAt",
            -- Текст последнего сообщения (или request_text если нет ответов)
            COALESCE(
              (SELECT text_content FROM request_responses WHERE request_id = r.id ORDER BY created_at DESC LIMIT 1),
              r.request_text
            ) AS "lastMsgText",
            (SELECT file_type FROM request_responses WHERE request_id = r.id ORDER BY created_at DESC LIMIT 1) AS "lastMsgFileType",
            COALESCE(
              (SELECT sender_type FROM request_responses WHERE request_id = r.id ORDER BY created_at DESC LIMIT 1),
              'manager'
            ) AS "lastMessageSender",
            -- Непрочитанные manager-сообщения после employee'й last_viewed_at
            (SELECT COUNT(*)::int FROM request_responses rr
              WHERE rr.request_id = r.id
                AND rr.sender_type = 'manager'
                AND rr.created_at > COALESCE(
                  (SELECT last_viewed_at FROM request_employee_views WHERE request_id = r.id AND employee_id = $1),
                  '1970-01-01'::timestamptz
                )
            ) AS "unreadCount"
     FROM employee_requests r
     LEFT JOIN request_targets rt ON rt.request_id = r.id AND rt.employee_id = $1
     WHERE (rt.employee_id = $1 OR r.initiated_by_employee_id = $1)
       AND r.status <> 'closed'
     ORDER BY
       (CASE WHEN (
         SELECT COUNT(*) FROM request_responses rr
         WHERE rr.request_id = r.id AND rr.sender_type = 'manager'
           AND rr.created_at > COALESCE(
             (SELECT last_viewed_at FROM request_employee_views WHERE request_id = r.id AND employee_id = $1),
             '1970-01-01'::timestamptz
           )
       ) > 0 THEN 0 ELSE 1 END),
       GREATEST(r.updated_at, COALESCE(
         (SELECT MAX(created_at) FROM request_responses WHERE request_id = r.id),
         r.updated_at
       )) DESC
     LIMIT 100`,
    [employeeId]
  );
  // Преобразуем preview: если последнее сообщение — файл без текста,
  // ставим эмодзи; если текст — обрезаем до 80 симв.
  return rows.map(r => {
    const txt = r.lastMsgText?.trim() ?? '';
    const fileEmoji =
      r.lastMsgFileType === 'photo' ? '📷 фото' :
      r.lastMsgFileType === 'video' ? '🎬 видео' :
      r.lastMsgFileType === 'document' ? '📎 файл' : '';
    const preview = txt
      ? (txt.length > 80 ? txt.slice(0, 80) + '…' : txt)
      : fileEmoji || '(пусто)';
    return {
      id: r.id,
      requestText: r.requestText,
      status: r.status,
      createdAt: r.createdAt,
      lastMessageAt: r.lastMessageAt,
      lastMessagePreview: preview,
      lastMessageSender: r.lastMessageSender,
      unreadCount: r.unreadCount,
    };
  });
}

/** Полный thread запроса с проверкой что сотрудник — target. Помечает прочитанным. */
export async function getEmployeeRequestThread(opts: {
  requestId: number;
  employeeId: number;
}): Promise<{ requestText: string; status: string; createdAt: string; messages: EmployeeChatMessage[] } | null> {
  // Проверяем что сотрудник имеет доступ — он target ИЛИ инициатор запроса
  const { rows: access } = await pool.query<{ id: number; requestText: string; status: string; createdAt: string }>(
    `SELECT r.id, r.request_text AS "requestText", r.status, r.created_at AS "createdAt"
     FROM employee_requests r
     LEFT JOIN request_targets rt ON rt.request_id = r.id AND rt.employee_id = $2
     WHERE r.id = $1 AND (rt.employee_id = $2 OR r.initiated_by_employee_id = $2)`,
    [opts.requestId, opts.employeeId]
  );
  if (!access[0]) return null;

  // Помечаем прочитанным
  await pool.query(
    `INSERT INTO request_employee_views (request_id, employee_id, last_viewed_at)
     VALUES ($1, $2, now())
     ON CONFLICT (request_id, employee_id) DO UPDATE SET last_viewed_at = now()`,
    [opts.requestId, opts.employeeId]
  );

  const { rows: messages } = await pool.query<EmployeeChatMessage>(
    `SELECT rr.id,
            rr.sender_type        AS "senderType",
            au.username           AS "adminUsername",
            rr.text_content       AS "textContent",
            rr.file_url           AS "fileUrl",
            rr.file_thumbnail_url AS "fileThumbnailUrl",
            rr.file_type          AS "fileType",
            rr.file_name          AS "fileName",
            rr.created_at         AS "createdAt"
     FROM request_responses rr
     LEFT JOIN admin_users au ON au.id = rr.admin_user_id
     WHERE rr.request_id = $1
     ORDER BY rr.created_at`,
    [opts.requestId]
  );

  return {
    requestText: access[0].requestText,
    status: access[0].status,
    createdAt: access[0].createdAt,
    messages,
  };
}

/** Сотрудник пишет в запрос. Создаёт response с sender_type='employee'.
 *  fileUrl уже должен быть загружен в Cloudinary (с фронта unsigned upload). */
export async function sendEmployeeMessage(opts: {
  requestId: number;
  employeeId: number;
  text?: string | null;
  fileUrl?: string | null;
  fileThumbnailUrl?: string | null;
  fileType?: 'photo' | 'video' | 'document' | null;
  fileName?: string | null;
}): Promise<{ messageId: number } | null> {
  // Доступ-чек — сотрудник target ИЛИ инициатор
  const { rows: access } = await pool.query<{ id: number; status: string }>(
    `SELECT r.id, r.status FROM employee_requests r
     LEFT JOIN request_targets rt ON rt.request_id = r.id AND rt.employee_id = $2
     WHERE r.id = $1 AND (rt.employee_id = $2 OR r.initiated_by_employee_id = $2)`,
    [opts.requestId, opts.employeeId]
  );
  if (!access[0]) return null;

  const text = (opts.text ?? '').trim() || null;
  if (!text && !opts.fileUrl) {
    throw new Error('Пустое сообщение');
  }

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO request_responses
       (request_id, employee_id, sender_type, text_content, file_url, file_thumbnail_url, file_type, file_name)
     VALUES ($1, $2, 'employee', $3, $4, $5, $6, $7)
     RETURNING id`,
    [opts.requestId, opts.employeeId, text, opts.fileUrl ?? null, opts.fileThumbnailUrl ?? null, opts.fileType ?? null, opts.fileName ?? null]
  );

  // Сотрудник написал — переоткрываем запрос если был closed (chat-mode)
  // и помечаем что он сам прочитал свой ответ.
  await pool.query(
    `UPDATE employee_requests SET
       status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
       updated_at = now()
     WHERE id = $1`,
    [opts.requestId]
  );
  await pool.query(
    `INSERT INTO request_employee_views (request_id, employee_id, last_viewed_at)
     VALUES ($1, $2, now())
     ON CONFLICT (request_id, employee_id) DO UPDATE SET last_viewed_at = now()`,
    [opts.requestId, opts.employeeId]
  );

  return { messageId: rows[0].id };
}

/** Общее число непрочитанных запросов для бейджа на иконке «Сообщения». */
export async function getEmployeeUnreadCount(employeeId: number): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(DISTINCT r.id)::int AS n
     FROM employee_requests r
     LEFT JOIN request_targets rt ON rt.request_id = r.id AND rt.employee_id = $1
     JOIN request_responses rr ON rr.request_id = r.id
     WHERE (rt.employee_id = $1 OR r.initiated_by_employee_id = $1)
       AND r.status <> 'closed'
       AND rr.sender_type = 'manager'
       AND rr.created_at > COALESCE(
         (SELECT last_viewed_at FROM request_employee_views WHERE request_id = r.id AND employee_id = $1),
         '1970-01-01'::timestamptz
       )`,
    [employeeId]
  );
  return rows[0]?.n ?? 0;
}
