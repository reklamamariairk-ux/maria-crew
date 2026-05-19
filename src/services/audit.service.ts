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
  | 'exchange_1c_retry_failed'
  | 'store_create'
  | 'store_update'
  | 'prize_create'
  | 'prize_update'
  | 'prize_delete'
  | 'quiz_question_create'
  | 'quiz_question_update'
  | 'quiz_question_delete'
  | 'quiz_question_import'
  | 'config_update'
  | 'hero_create'
  | 'hero_update'
  | 'hero_delete'
  | 'broadcast'
  | 'challenge_create'
  | 'challenge_update'
  | 'challenge_delete'
  | 'challenge_award'
  | 'admin_user_create'
  | 'admin_user_update'
  | 'admin_user_delete'
  | 'backup_download';

/** Записывает событие в audit_log. Не бросает исключений — фоновый журнал */
export async function logAudit(
  action: AuditAction,
  details: Record<string, unknown>,
  performedBy?: string
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (action, details, performed_by) VALUES ($1, $2::jsonb, $3)`,
      [action, JSON.stringify(details), performedBy ?? null]
    );
  } catch (err) {
    console.error('[audit] failed:', err instanceof Error ? err.message : err);
  }
}

export interface AuditLogEntry {
  id: number;
  action: string;
  details: Record<string, unknown>;
  performedBy: string | null;
  createdAt: string;
}

export async function getAuditLog(
  limit = 50,
  offset = 0
): Promise<{ data: AuditLogEntry[]; total: number }> {
  const [logResult, countResult] = await Promise.all([
    pool.query<AuditLogEntry>(
      `SELECT id, action, details, performed_by AS "performedBy",
              to_char(created_at AT TIME ZONE 'Asia/Irkutsk', 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt"
       FROM admin_audit_log
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM admin_audit_log`
    ),
  ]);

  return {
    data: logResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}
