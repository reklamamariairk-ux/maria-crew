import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { logAudit } from '../../services/audit.service';
import { calculateOfficeScore, type OfficeMetricDefinition } from '../../services/officeMetrics.service';

const router = Router();

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function periodFrom(query: Record<string, unknown>): { year: number; month: number } | null {
  const year = Number(query.year);
  const month = Number(query.month);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function cleanText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function metricCode(name: string): string {
  const base = name.toLowerCase()
    .replace(/[^a-zа-яё0-9]+/giu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'metric';
  return `${base}_${Date.now().toString(36)}`;
}

interface DefinitionRow extends OfficeMetricDefinition {
  code: string;
  name: string;
  unit: string;
  sortOrder: number;
  isActive: boolean;
}

interface OperatorRow {
  id: number;
  teamId: number | null;
  teamName: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  joinedAt: string | null;
  notes: string | null;
  isActive: boolean;
}

async function definitions(activeOnly = false): Promise<DefinitionRow[]> {
  const { rows } = await pool.query<DefinitionRow>(
    `SELECT id, code, name, unit,
            target_value::float8 AS "targetValue",
            weight::float8 AS weight,
            direction, sort_order AS "sortOrder", is_active AS "isActive"
       FROM office_metric_definitions
      ${activeOnly ? 'WHERE is_active = true' : ''}
      ORDER BY sort_order, id`
  );
  return rows;
}

async function operators(teamId: number | null, activeOnly = false): Promise<OperatorRow[]> {
  const params: number[] = [];
  const where: string[] = [];
  if (teamId) { params.push(teamId); where.push(`o.team_id = $${params.length}`); }
  if (activeOnly) where.push('o.is_active = true');
  const { rows } = await pool.query<OperatorRow>(
    `SELECT o.id, o.team_id AS "teamId", t.name AS "teamName", o.name,
            o.phone, o.email, o.joined_at AS "joinedAt", o.notes,
            o.is_active AS "isActive"
       FROM office_operators o
       LEFT JOIN office_teams t ON t.id = o.team_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY o.is_active DESC, o.name`,
    params
  );
  return rows;
}

async function metricsPayload(year: number, month: number, teamId: number | null) {
  const [defs, ops] = await Promise.all([definitions(true), operators(teamId, true)]);
  const valuesByOperator: Record<number, Record<number, number>> = {};
  if (ops.length) {
    const ids = ops.map(operator => operator.id);
    const { rows } = await pool.query<{ operatorId: number; metricId: number; value: number }>(
      `SELECT operator_id AS "operatorId", metric_id AS "metricId", value::float8 AS value
         FROM office_metric_values
        WHERE year = $1 AND month = $2 AND operator_id = ANY($3::int[])`,
      [year, month, ids]
    );
    for (const row of rows) {
      (valuesByOperator[row.operatorId] ??= {})[row.metricId] = Number(row.value);
    }
  }

  const items = ops.map(operator => ({
    ...operator,
    values: valuesByOperator[operator.id] ?? {},
    score: calculateOfficeScore(defs, valuesByOperator[operator.id] ?? {}),
  }));
  return { year, month, definitions: defs, operators: items };
}

// ── Команды ────────────────────────────────────────────────────────────────

router.get('/teams', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.is_active AS "isActive",
              COUNT(o.id) FILTER (WHERE o.is_active = true)::int AS "activeOperators"
         FROM office_teams t
         LEFT JOIN office_operators o ON o.team_id = t.id
        GROUP BY t.id
        ORDER BY t.is_active DESC, t.name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/teams', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const name = cleanText(req.body?.name, 100);
    if (!name) { res.status(400).json({ error: 'Название команды обязательно' }); return; }
    const { rows } = await pool.query(
      `INSERT INTO office_teams(name) VALUES ($1)
       RETURNING id, name, is_active AS "isActive"`, [name]
    );
    res.status(201).json(rows[0]);
    logAudit('office_team_create', { teamId: rows[0].id, name }, req.ip).catch(() => {});
  } catch (err) {
    if (err instanceof Error && /duplicate|unique/i.test(err.message)) {
      res.status(409).json({ error: 'Команда с таким названием уже существует' }); return;
    }
    next(err);
  }
});

router.put('/teams/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = positiveId(req.params.id);
    if (!id) { res.status(400).json({ error: 'Некорректный id' }); return; }
    const name = req.body?.name === undefined ? undefined : cleanText(req.body.name, 100);
    const isActive = typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined;
    if (name === null) { res.status(400).json({ error: 'Название не может быть пустым' }); return; }
    if (name === undefined && isActive === undefined) { res.status(400).json({ error: 'Нечего обновлять' }); return; }
    const { rows } = await pool.query(
      `UPDATE office_teams
          SET name = COALESCE($1, name), is_active = COALESCE($2, is_active), updated_at = NOW()
        WHERE id = $3
        RETURNING id, name, is_active AS "isActive"`,
      [name ?? null, isActive ?? null, id]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Команда не найдена' }); return; }
    res.json(rows[0]);
    logAudit('office_team_update', { teamId: id, name, isActive }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

// ── Операторы ──────────────────────────────────────────────────────────────

router.get('/operators', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const teamId = req.query.teamId ? positiveId(req.query.teamId) : null;
    res.json(await operators(teamId, req.query.active === '1'));
  } catch (err) { next(err); }
});

router.post('/operators', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const name = cleanText(req.body?.name, 100);
    const teamId = req.body?.teamId ? positiveId(req.body.teamId) : null;
    if (!name) { res.status(400).json({ error: 'Имя оператора обязательно' }); return; }
    if (req.body?.teamId && !teamId) { res.status(400).json({ error: 'Некорректная команда' }); return; }
    const { rows } = await pool.query(
      `INSERT INTO office_operators(team_id, name, phone, email, joined_at, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, team_id AS "teamId", name, phone, email,
                 joined_at AS "joinedAt", notes, is_active AS "isActive"`,
      [teamId, name, cleanText(req.body?.phone, 32), cleanText(req.body?.email, 254),
       cleanText(req.body?.joinedAt, 10), cleanText(req.body?.notes, 2000)]
    );
    res.status(201).json(rows[0]);
    logAudit('office_operator_create', { operatorId: rows[0].id, teamId, name }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

router.put('/operators/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = positiveId(req.params.id);
    if (!id) { res.status(400).json({ error: 'Некорректный id' }); return; }
    const name = req.body?.name === undefined ? undefined : cleanText(req.body.name, 100);
    const teamId = req.body?.teamId === undefined ? undefined : (req.body.teamId ? positiveId(req.body.teamId) : null);
    if (name === null) { res.status(400).json({ error: 'Имя не может быть пустым' }); return; }
    if (req.body?.teamId && !teamId) { res.status(400).json({ error: 'Некорректная команда' }); return; }
    const isActive = typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined;
    const { rows } = await pool.query(
      `UPDATE office_operators SET
         name = COALESCE($1, name),
         team_id = CASE WHEN $2::boolean THEN $3 ELSE team_id END,
         phone = CASE WHEN $4::boolean THEN $5 ELSE phone END,
         email = CASE WHEN $6::boolean THEN $7 ELSE email END,
         joined_at = CASE WHEN $8::boolean THEN $9::date ELSE joined_at END,
         notes = CASE WHEN $10::boolean THEN $11 ELSE notes END,
         is_active = COALESCE($12, is_active), updated_at = NOW()
       WHERE id = $13
       RETURNING id, team_id AS "teamId", name, phone, email,
                 joined_at AS "joinedAt", notes, is_active AS "isActive"`,
      [name ?? null,
       req.body?.teamId !== undefined, teamId ?? null,
       req.body?.phone !== undefined, cleanText(req.body?.phone, 32),
       req.body?.email !== undefined, cleanText(req.body?.email, 254),
       req.body?.joinedAt !== undefined, cleanText(req.body?.joinedAt, 10),
       req.body?.notes !== undefined, cleanText(req.body?.notes, 2000),
       isActive ?? null, id]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Оператор не найден' }); return; }
    res.json(rows[0]);
    logAudit('office_operator_update', { operatorId: id, teamId, isActive }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

// ── Настраиваемые показатели и значения ───────────────────────────────────

router.get('/metric-definitions', async (_req, res, next) => {
  try { res.json(await definitions(false)); } catch (err) { next(err); }
});

router.post('/metric-definitions', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const name = cleanText(req.body?.name, 100);
    const unit = cleanText(req.body?.unit, 24) ?? '';
    const targetValue = Number(req.body?.targetValue);
    const weight = Number(req.body?.weight ?? 1);
    const direction = req.body?.direction === 'lower' ? 'lower' : 'higher';
    if (!name) { res.status(400).json({ error: 'Название показателя обязательно' }); return; }
    if (!Number.isFinite(targetValue) || targetValue < 0) { res.status(400).json({ error: 'Некорректная норма' }); return; }
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) { res.status(400).json({ error: 'Вес должен быть от 0 до 100' }); return; }
    const { rows } = await pool.query(
      `INSERT INTO office_metric_definitions(code, name, unit, target_value, weight, direction, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6,
               COALESCE((SELECT MAX(sort_order) + 1 FROM office_metric_definitions), 0))
       RETURNING id, code, name, unit, target_value::float8 AS "targetValue",
                 weight::float8 AS weight, direction, sort_order AS "sortOrder", is_active AS "isActive"`,
      [metricCode(name), name, unit, targetValue, weight, direction]
    );
    res.status(201).json(rows[0]);
    logAudit('office_metric_create', { metricId: rows[0].id, name }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

router.put('/metric-definitions/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = positiveId(req.params.id);
    if (!id) { res.status(400).json({ error: 'Некорректный id' }); return; }
    const name = req.body?.name === undefined ? undefined : cleanText(req.body.name, 100);
    const targetValue = req.body?.targetValue === undefined ? undefined : Number(req.body.targetValue);
    const weight = req.body?.weight === undefined ? undefined : Number(req.body.weight);
    const direction = req.body?.direction === undefined ? undefined : req.body.direction;
    if (name === null) { res.status(400).json({ error: 'Название не может быть пустым' }); return; }
    if (targetValue !== undefined && (!Number.isFinite(targetValue) || targetValue < 0)) { res.status(400).json({ error: 'Некорректная норма' }); return; }
    if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 100)) { res.status(400).json({ error: 'Вес должен быть от 0 до 100' }); return; }
    if (direction !== undefined && direction !== 'higher' && direction !== 'lower') { res.status(400).json({ error: 'Некорректное направление' }); return; }
    const { rows } = await pool.query(
      `UPDATE office_metric_definitions SET
         name = COALESCE($1, name),
         unit = CASE WHEN $2::boolean THEN $3 ELSE unit END,
         target_value = COALESCE($4, target_value),
         weight = COALESCE($5, weight),
         direction = COALESCE($6, direction),
         is_active = COALESCE($7, is_active), updated_at = NOW()
       WHERE id = $8
       RETURNING id, code, name, unit, target_value::float8 AS "targetValue",
                 weight::float8 AS weight, direction, sort_order AS "sortOrder", is_active AS "isActive"`,
      [name ?? null, req.body?.unit !== undefined, cleanText(req.body?.unit, 24) ?? '',
       targetValue ?? null, weight ?? null, direction ?? null,
       typeof req.body?.isActive === 'boolean' ? req.body.isActive : null, id]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Показатель не найден' }); return; }
    res.json(rows[0]);
    logAudit('office_metric_update', { metricId: id }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

router.get('/metrics', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const period = periodFrom(req.query as Record<string, unknown>);
    if (!period) { res.status(400).json({ error: 'Некорректный период' }); return; }
    const teamId = req.query.teamId ? positiveId(req.query.teamId) : null;
    res.json(await metricsPayload(period.year, period.month, teamId));
  } catch (err) { next(err); }
});

router.put('/metrics', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const period = periodFrom(req.body ?? {});
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!period || !items) { res.status(400).json({ error: 'Период и items обязательны' }); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const item of items) {
      const operatorId = positiveId(item?.operatorId);
      if (!operatorId || typeof item?.values !== 'object' || item.values === null) {
        throw new Error('Некорректная строка метрик');
      }
      for (const [metricIdRaw, rawValue] of Object.entries(item.values)) {
        const metricId = positiveId(metricIdRaw);
        if (!metricId) throw new Error('Некорректный показатель');
        if (rawValue === null || rawValue === '') {
          await client.query(
            `DELETE FROM office_metric_values
              WHERE operator_id = $1 AND metric_id = $2 AND year = $3 AND month = $4`,
            [operatorId, metricId, period.year, period.month]
          );
          continue;
        }
        const value = Number(rawValue);
        if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) throw new Error('Некорректное значение показателя');
        const result = await client.query(
          `INSERT INTO office_metric_values(operator_id, metric_id, year, month, value)
           SELECT $1, d.id, $3, $4, $5
             FROM office_metric_definitions d
             JOIN office_operators o ON o.id = $1
            WHERE d.id = $2
           ON CONFLICT (operator_id, metric_id, year, month) DO UPDATE SET
             value = EXCLUDED.value, updated_at = NOW()`,
          [operatorId, metricId, period.year, period.month, value]
        );
        if (result.rowCount !== 1) throw new Error('Некорректный оператор или показатель');
        saved++;
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, saved });
    logAudit('office_metrics_save', { ...period, saved }, req.ip).catch(() => {});
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof Error && /Некоррект/.test(err.message)) {
      res.status(400).json({ error: err.message }); return;
    }
    next(err);
  } finally { client.release(); }
});

router.get('/dashboard', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const irk = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const year = irk.getUTCFullYear();
    const month = irk.getUTCMonth() + 1;
    const teamId = req.query.teamId ? positiveId(req.query.teamId) : null;
    const payload = await metricsPayload(year, month, teamId);
    const topOperators = payload.operators
      .filter(operator => operator.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3)
      .map(({ id, name, teamName, score }) => ({ id, name, teamName, score }));
    const activeTeams = new Set(payload.operators.map(operator => operator.teamId).filter(Boolean)).size;
    const metricsFilled = payload.operators.filter(operator => Object.keys(operator.values).length > 0).length;
    res.json({
      year, month,
      activeOperators: payload.operators.length,
      activeTeams,
      metricsFilled,
      topOperators,
      definitionsCount: payload.definitions.length,
    });
  } catch (err) { next(err); }
});

export default router;
