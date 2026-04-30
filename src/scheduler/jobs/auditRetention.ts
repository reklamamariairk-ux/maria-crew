import { pool } from '../../db/pool';

/**
 * Каждый день в 03:30 Иркутска — чистим журнал старше 6 месяцев.
 * Это предотвращает раздувание admin_audit_log на больших объёмах.
 */
export async function auditRetention(): Promise<void> {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM admin_audit_log WHERE created_at < NOW() - INTERVAL '6 months'`
    );
    if (rowCount && rowCount > 0) {
      console.log(`[audit-retention] удалено ${rowCount} старых записей журнала`);
    }
  } catch (err) {
    console.error('[audit-retention] error:', err instanceof Error ? err.message : err);
  }
}
