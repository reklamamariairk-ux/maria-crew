/**
 * «Торт месяца»: физический приз (торт или пирог «Мария») победителям —
 * лучшей точке (is_top в store_monthly_stats) и КАЖДОМУ сотруднику со статусом
 * «Лучший» (is_mvp в monthly_metrics — авторасчёт или отметка админа в Рейтинге;
 * лучших на точке может быть несколько).
 *
 * Идемпотентно: уникальный индекс monthly_prizes_uniq — повторное «Обработать
 * месяц» не задваивает призы и не рассылает повторные уведомления
 * (created=false), но ДОБАВЛЯЕТ торты сотрудникам, отмеченным после прошлого
 * прогона. Снятие статуса «Лучший» уже выданный торт не отзывает — лишнюю
 * запись админ удаляет руками в секции «Торты месяца».
 * Запись в monthly_prizes — источник правды для админа, кто в этом месяце
 * получает торт.
 */
import { pool } from '../db/pool';
import { toNum } from './rating.service';
import { logAudit } from './audit.service';
import type { AdminWorkspace } from './adminWorkspace.service';

export interface CakeWinner {
  kind: 'top_store' | 'best_employee';
  storeId: number | null;
  employeeId: number | null;
  name: string;
  score: number | null; // null у добавленных вручную без баллов месяца
  created: boolean; // false = приз уже был записан ранее (повторный прогон)
}

// Конфликт-цель = уникальный индекс monthly_prizes_uniq (066)
const CONFLICT = `(workspace, year, month, kind, COALESCE(employee_id, 0), COALESCE(store_id, 0))`;

export async function awardMonthlyCakes(
  year: number,
  month: number,
  workspace: AdminWorkspace = 'retail',
): Promise<CakeWinner[]> {
  const winners: CakeWinner[] = [];
  // Топ-точка — только если приза этого вида в месяце ещё НЕТ: иначе повторный
  // «Обработать месяц» после правки баллов добавил бы ВТОРОЙ авто-торт другой
  // точке. Сотрудники же идут по флагам is_mvp — там повторный прогон ДОЛЖЕН
  // доначислять отмеченным позже (дубли режет уникальный индекс).
  const { rows: existing } = await pool.query<{ kind: string }>(
    `SELECT DISTINCT kind FROM monthly_prizes WHERE year = $1 AND month = $2 AND workspace = $3`,
    [year, month, workspace]);
  const hasKind = new Set(existing.map(r => r.kind));

  // ── топ-точка месяца ──
  if (!hasKind.has('top_store')) {
    const { rows: topStore } = await pool.query<{ storeId: number; name: string; totalScore: string | null }>(
      `SELECT sms.store_id AS "storeId", s.name, sms.total_score AS "totalScore"
       FROM store_monthly_stats sms JOIN stores s ON s.id = sms.store_id
       WHERE sms.year = $1 AND sms.month = $2 AND sms.is_top = true AND s.workspace = $3
       LIMIT 1`,
      [year, month, workspace]
    );
    if (topStore[0]) {
      const ins = await pool.query(
        `INSERT INTO monthly_prizes (year, month, kind, store_id, workspace) VALUES ($1, $2, 'top_store', $3, $4)
         ON CONFLICT ${CONFLICT} DO NOTHING RETURNING id`,
        [year, month, topStore[0].storeId, workspace]
      );
      winners.push({
        kind: 'top_store', storeId: topStore[0].storeId, employeeId: null,
        name: topStore[0].name, score: toNum(topStore[0].totalScore) ?? 0,
        created: ins.rows.length > 0,
      });
    }
  }

  // ── лучшие сотрудники (все отмеченные is_mvp, лучших на точке может быть несколько) ──
  // Порога по баллам нет: флаг is_mvp — уже осознанное решение (авторасчёт с
  // порогом внутри либо ручная отметка руководителя, как в addManualCakePrize).
  const { rows: mvps } = await pool.query<{ employeeId: number; name: string; storeId: number | null; mvpScore: string | null }>(
    `SELECT mm.employee_id AS "employeeId", e.name, e.store_id AS "storeId", mm.mvp_score AS "mvpScore"
     FROM monthly_metrics mm JOIN employees e ON e.id = mm.employee_id
     WHERE mm.year = $1 AND mm.month = $2 AND mm.workspace = $3
       AND mm.is_mvp = true AND e.fired_at IS NULL
     ORDER BY e.name ASC`,
    [year, month, workspace]
  );
  for (const m of mvps) {
    const ins = await pool.query(
      `INSERT INTO monthly_prizes (year, month, kind, employee_id, store_id, workspace)
       VALUES ($1, $2, 'best_employee', $3, $4, $5)
       ON CONFLICT ${CONFLICT} DO NOTHING RETURNING id`,
      [year, month, m.employeeId, m.storeId, workspace]
    );
    winners.push({
      kind: 'best_employee', storeId: m.storeId, employeeId: m.employeeId,
      name: m.name, score: toNum(m.mvpScore),
      created: ins.rows.length > 0,
    });
  }

  const fresh = winners.filter(w => w.created);
  if (fresh.length) {
    logAudit('cake_prize', {
      year, month, workspace,
      winners: fresh.map(w => ({ kind: w.kind, storeId: w.storeId, employeeId: w.employeeId, name: w.name })),
    }).catch(() => {});
  }
  return winners;
}

/**
 * Ручное добавление ЕЩЁ ОДНОГО сотрудника к «торту месяца» (решение руководителя).
 * Дубль того же человека в месяце — created=false (уникальный индекс), уволенным нельзя.
 */
export async function addManualCakePrize(
  year: number,
  month: number,
  employeeId: number,
  performedBy?: string,
  workspace: AdminWorkspace = 'retail',
): Promise<CakeWinner | null> {
  const { rows: emp } = await pool.query<{ id: number; name: string; storeId: number | null; firedAt: string | null }>(
    workspace === 'office'
      ? `SELECT e.id, e.name, COALESCE(oem.office_store_id, e.store_id) AS "storeId", e.fired_at AS "firedAt"
         FROM employees e
         LEFT JOIN office_employee_memberships oem ON oem.employee_id = e.id
         LEFT JOIN stores s ON s.id = e.store_id
         WHERE e.id = $1 AND (oem.employee_id IS NOT NULL OR s.workspace = 'office')`
      : `SELECT e.id, e.name, e.store_id AS "storeId", e.fired_at AS "firedAt"
         FROM employees e JOIN stores s ON s.id = e.store_id
         WHERE e.id = $1 AND s.workspace = 'retail'`,
    [employeeId],
  );
  if (!emp[0] || emp[0].firedAt) return null;
  const { rows: score } = await pool.query<{ mvpScore: string | null }>(
    `SELECT mvp_score AS "mvpScore" FROM monthly_metrics
     WHERE employee_id = $1 AND year = $2 AND month = $3 AND workspace = $4`,
    [employeeId, year, month, workspace]
  );
  const ins = await pool.query(
    `INSERT INTO monthly_prizes (year, month, kind, employee_id, store_id, workspace)
     VALUES ($1, $2, 'best_employee', $3, $4, $5)
     ON CONFLICT ${CONFLICT} DO NOTHING RETURNING id`,
    [year, month, employeeId, emp[0].storeId, workspace]
  );
  const winner: CakeWinner = {
    kind: 'best_employee', storeId: emp[0].storeId, employeeId,
    name: emp[0].name, score: score[0] ? toNum(score[0].mvpScore) : null,
    created: ins.rows.length > 0,
  };
  if (winner.created) {
    logAudit('cake_prize', { year, month, workspace, manual: true, employeeId, name: emp[0].name }, performedBy).catch(() => {});
  }
  return winner;
}

/** Список тортов месяца для админки (с именами). */
export async function listCakePrizes(
  year: number,
  month: number,
  workspace: AdminWorkspace = 'retail',
) {
  const { rows } = await pool.query(
    `SELECT p.id, p.kind, p.employee_id AS "employeeId", p.store_id AS "storeId",
            p.prize_label AS "prizeLabel", p.created_at AS "createdAt",
            e.name AS "employeeName", s.name AS "storeName"
     FROM monthly_prizes p
     LEFT JOIN employees e ON e.id = p.employee_id
     LEFT JOIN stores s ON s.id = p.store_id
     WHERE p.year = $1 AND p.month = $2 AND p.workspace = $3
     ORDER BY p.kind, p.created_at`,
    [year, month, workspace]
  );
  return rows;
}
