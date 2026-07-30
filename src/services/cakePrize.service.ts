/**
 * «Торт месяца»: физический приз (торт или пирог «Мария») двум победителям сети —
 * лучшей точке (is_top в store_monthly_stats) и лучшему сотруднику СЕТИ
 * (максимальный mvp_score месяца среди всех точек, не ниже mvpMinScore).
 *
 * Идемпотентно: UNIQUE(year, month, kind) — повторное «Обработать месяц» не
 * задваивает призы и не рассылает повторные уведомления (created=false).
 * Запись в monthly_prizes — источник правды для админа, кто в этом месяце
 * получает торт.
 */
import { pool } from '../db/pool';
import { getMvpConfig } from './mvpConfig.service';
import { toNum } from './rating.service';
import { logAudit } from './audit.service';

export interface CakeWinner {
  kind: 'top_store' | 'best_employee';
  storeId: number | null;
  employeeId: number | null;
  name: string;
  score: number;
  created: boolean; // false = приз уже был записан ранее (повторный прогон)
}

export async function awardMonthlyCakes(year: number, month: number): Promise<CakeWinner[]> {
  const winners: CakeWinner[] = [];

  // ── топ-точка месяца ──
  const { rows: topStore } = await pool.query<{ storeId: number; name: string; totalScore: string | null }>(
    `SELECT sms.store_id AS "storeId", s.name, sms.total_score AS "totalScore"
     FROM store_monthly_stats sms JOIN stores s ON s.id = sms.store_id
     WHERE sms.year = $1 AND sms.month = $2 AND sms.is_top = true
     LIMIT 1`,
    [year, month]
  );
  if (topStore[0]) {
    const ins = await pool.query(
      `INSERT INTO monthly_prizes (year, month, kind, store_id) VALUES ($1, $2, 'top_store', $3)
       ON CONFLICT (year, month, kind) DO NOTHING RETURNING id`,
      [year, month, topStore[0].storeId]
    );
    winners.push({
      kind: 'top_store', storeId: topStore[0].storeId, employeeId: null,
      name: topStore[0].name, score: toNum(topStore[0].totalScore) ?? 0,
      created: ins.rows.length > 0,
    });
  }

  // ── лучший сотрудник сети ──
  const cfg = await getMvpConfig();
  const { rows: best } = await pool.query<{ employeeId: number; name: string; storeId: number; mvpScore: string | null }>(
    `SELECT mm.employee_id AS "employeeId", e.name, e.store_id AS "storeId", mm.mvp_score AS "mvpScore"
     FROM monthly_metrics mm JOIN employees e ON e.id = mm.employee_id
     WHERE mm.year = $1 AND mm.month = $2 AND e.is_active = true AND e.fired_at IS NULL
       AND mm.mvp_score IS NOT NULL
     ORDER BY mm.mvp_score DESC, e.name ASC
     LIMIT 1`,
    [year, month]
  );
  const bestScore = best[0] ? (toNum(best[0].mvpScore) ?? 0) : 0;
  if (best[0] && bestScore >= cfg.mvpMinScore) {
    const ins = await pool.query(
      `INSERT INTO monthly_prizes (year, month, kind, employee_id, store_id) VALUES ($1, $2, 'best_employee', $3, $4)
       ON CONFLICT (year, month, kind) DO NOTHING RETURNING id`,
      [year, month, best[0].employeeId, best[0].storeId]
    );
    winners.push({
      kind: 'best_employee', storeId: best[0].storeId, employeeId: best[0].employeeId,
      name: best[0].name, score: bestScore,
      created: ins.rows.length > 0,
    });
  }

  const fresh = winners.filter(w => w.created);
  if (fresh.length) {
    logAudit('cake_prize', {
      year, month,
      winners: fresh.map(w => ({ kind: w.kind, storeId: w.storeId, employeeId: w.employeeId, name: w.name })),
    }).catch(() => {});
  }
  return winners;
}
