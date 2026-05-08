// Универсальный «inbox» для уведомлений сотрудников. Хранит историю того, что
// раньше только улетало в Telegram/push. UI рисует колокольчик с непрочитанными.

import { pool } from '../db/pool';

export type NotificationType =
  | 'coin_award'
  | 'card_award'
  | 'exchange'
  | 'challenge'
  | 'system';

export interface NotificationRecord {
  id: number;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: Date | null;
  createdAt: Date;
}

/** Сохраняет уведомление в inbox. Не падает наверх — fire-and-forget. */
export async function saveNotification(
  employeeId: number,
  notif: { type: NotificationType; title: string; body: string; data?: Record<string, unknown> }
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO notifications (employee_id, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [employeeId, notif.type, notif.title, notif.body, notif.data ? JSON.stringify(notif.data) : null]
    );
  } catch (err) {
    console.error('[notif] save failed:', err instanceof Error ? err.message : err);
  }
}

export async function listNotifications(employeeId: number, limit = 50): Promise<NotificationRecord[]> {
  const { rows } = await pool.query<NotificationRecord>(
    `SELECT id, type, title, body, data,
            read_at AS "readAt", created_at AS "createdAt"
     FROM notifications
     WHERE employee_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [employeeId, Math.min(Math.max(limit, 1), 200)]
  );
  return rows;
}

export async function countUnread(employeeId: number): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notifications
     WHERE employee_id = $1 AND read_at IS NULL`,
    [employeeId]
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

export async function markAsRead(employeeId: number, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE employee_id = $1 AND id = ANY($2::int[]) AND read_at IS NULL`,
    [employeeId, ids]
  );
  return rowCount ?? 0;
}

export async function markAllAsRead(employeeId: number): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE employee_id = $1 AND read_at IS NULL`,
    [employeeId]
  );
  return rowCount ?? 0;
}
