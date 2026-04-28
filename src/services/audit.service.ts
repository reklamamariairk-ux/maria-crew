import { pool } from '../db/pool';

export type AuditAction =
  | 'coin_award'
  | 'card_grant'
  | 'card_revoke'
  | 'card_spent_toggle'
  | 'employee_create'
  | 'employee_update'
  | 'employee_store_change'
  | 'employee_deactivate'
  | 'employee_activate'
  | 'metrics_save'
  | 'metrics_process'
  | 'rating_score_set'
  | 'rating_mvp_set'
  | 'rating_top_set'
  | 'exchange_fulfill'
  | 'exchange_reject'
  | 'store_create'
  | 'store_update'
  | 'prize_create'
  | 'prize_update'
  | 'prize_delete'
  | 'quiz_question_create'
  | 'quiz_question_update'
  | 'quiz_question_delete';

/** Записывает событие в audit_log. Не бросает исключений — фоновый журнал */
export async function logAudit(
  action: AuditAction,
  details: Record<string, unknown>
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (action, details) VALUES ($1, $2::jsonb)`,
      [action, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('[audit] failed:', err instanceof Error ? err.message : err);
  }
}

/** Возвращает последние N записей лога с человеко-читаемыми полями */
export async function getAuditLog(limit = 100): Promise<Array<{
  id: number;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}>> {
  const { rows } = await pool.query<{
    id: number; action: string; details: Record<string, unknown>; createdAt: string;
  }>(
    `SELECT id, action, details,
            to_char(created_at AT TIME ZONE 'Asia/Irkutsk', 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt"
     FROM admin_audit_log
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}
