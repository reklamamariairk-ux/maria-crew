import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { listChallenges, createChallenge, updateChallenge, awardChallengeCard, deleteChallenge } from '../../services/challenge.service';
import { logAudit } from '../../services/audit.service';
import { areEmployeesInWorkspace, workspaceForRequest } from '../../services/adminWorkspace.service';

const router = Router();

async function storesAllowed(req: Request, storeIds: number[] | null): Promise<boolean> {
  if (!storeIds?.length) return true;
  const ids = [...new Set(storeIds)];
  const { rows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM stores WHERE id = ANY($1::int[]) AND workspace = $2`,
    [ids, workspaceForRequest(req)],
  );
  return Number(rows[0]?.count ?? 0) === ids.length;
}

router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await listChallenges(workspaceForRequest(req)));
  } catch (err) { next(err); }
});

const VALID_SEASONS = new Set(['spring', 'summer', 'autumn', 'winter']);

router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, description, season, year, heroId, startDate, endDate, conditionDescription, coinReward, storeIds } = req.body;
    if (!name || !season || !year || !startDate || !endDate) {
      res.status(400).json({ error: 'name, season, year, startDate, endDate обязательны' });
      return;
    }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
      res.status(400).json({ error: 'name пустой или слишком длинный' });
      return;
    }
    if (!VALID_SEASONS.has(season)) {
      res.status(400).json({ error: `season должен быть: ${[...VALID_SEASONS].join(', ')}` });
      return;
    }
    const yearNum = Number(year);
    if (!Number.isInteger(yearNum) || yearNum < 2024 || yearNum > 2100) {
      res.status(400).json({ error: 'year должен быть 2024–2100' });
      return;
    }
    if (new Date(startDate) >= new Date(endDate)) {
      res.status(400).json({ error: 'startDate должен быть раньше endDate' });
      return;
    }

    // coinReward — необязательный, целое >= 0
    let coinRewardNum = 0;
    if (coinReward !== undefined && coinReward !== null && coinReward !== '') {
      coinRewardNum = Number(coinReward);
      if (!Number.isInteger(coinRewardNum) || coinRewardNum < 0 || coinRewardNum > 1000) {
        res.status(400).json({ error: 'coinReward — целое 0..1000' });
        return;
      }
    }

    // storeIds — необязательный массив id точек (null/undefined = все точки)
    let storeIdsArr: number[] | null = null;
    if (storeIds !== undefined && storeIds !== null) {
      if (!Array.isArray(storeIds)) {
        res.status(400).json({ error: 'storeIds должен быть массивом' });
        return;
      }
      storeIdsArr = storeIds
        .map(id => Number(id))
        .filter(id => Number.isInteger(id) && id > 0);
      // Пустой массив = «никому» — допустимо, но предупредим логом
      if (storeIdsArr.length === 0) storeIdsArr = null; // трактуем как «все»
    }
    if (!(await storesAllowed(req, storeIdsArr))) {
      res.status(403).json({ error: 'Одна из команд недоступна в текущем контуре' }); return;
    }

    try {
      const ch = await createChallenge({
        name: name.trim(), description, season, year: yearNum, heroId,
        startDate, endDate, conditionDescription,
        coinReward: coinRewardNum,
        storeIds: storeIdsArr,
      }, workspaceForRequest(req));
      res.status(201).json(ch);
      logAudit('challenge_create', { challengeId: ch.id, name, season, year: yearNum, coinReward: coinRewardNum, storeIds: storeIdsArr, workspace: workspaceForRequest(req) }, req.ip).catch(() => {});
    } catch (err) {
      // Постгрес 23505 — нарушение уникального индекса
      if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
        res.status(409).json({ error: 'Челлендж с такими параметрами уже существует' });
        return;
      }
      throw err;
    }
  } catch (err) { next(err); }
});

// PUT /api/challenges/:id — редактирование челленджа
router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }

    const { name, description, season, year, heroId, startDate, endDate, conditionDescription, coinReward, storeIds, isActive } = req.body;

    const fields: Parameters<typeof updateChallenge>[1] = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
        res.status(400).json({ error: 'name пустой или слишком длинный' });
        return;
      }
      fields.name = name.trim();
    }
    if (description !== undefined) fields.description = description ?? null;
    if (conditionDescription !== undefined) fields.conditionDescription = conditionDescription ?? null;

    if (season !== undefined) {
      if (!VALID_SEASONS.has(season)) {
        res.status(400).json({ error: `season должен быть: ${[...VALID_SEASONS].join(', ')}` });
        return;
      }
      fields.season = season;
    }

    if (year !== undefined) {
      const yearNum = Number(year);
      if (!Number.isInteger(yearNum) || yearNum < 2024 || yearNum > 2100) {
        res.status(400).json({ error: 'year должен быть 2024–2100' });
        return;
      }
      fields.year = yearNum;
    }

    if (heroId !== undefined) {
      // null или число — null значит «без карточки»
      fields.heroId = heroId === null || heroId === '' ? null : Number(heroId);
      if (fields.heroId !== null && !Number.isInteger(fields.heroId)) {
        res.status(400).json({ error: 'heroId должен быть числом или null' });
        return;
      }
    }

    if (startDate !== undefined) fields.startDate = startDate;
    if (endDate !== undefined) fields.endDate = endDate;
    if (fields.startDate && fields.endDate && new Date(fields.startDate) >= new Date(fields.endDate)) {
      res.status(400).json({ error: 'startDate должен быть раньше endDate' });
      return;
    }

    if (coinReward !== undefined) {
      const n = Number(coinReward);
      if (!Number.isInteger(n) || n < 0 || n > 1000) {
        res.status(400).json({ error: 'coinReward — целое 0..1000' });
        return;
      }
      fields.coinReward = n;
    }

    if (storeIds !== undefined) {
      if (storeIds === null) {
        fields.storeIds = null;
      } else {
        if (!Array.isArray(storeIds)) {
          res.status(400).json({ error: 'storeIds должен быть массивом или null' });
          return;
        }
        const arr = storeIds.map((id: unknown) => Number(id)).filter(id => Number.isInteger(id) && id > 0);
      fields.storeIds = arr.length === 0 ? null : arr;
      if (!(await storesAllowed(req, fields.storeIds))) {
        res.status(403).json({ error: 'Одна из команд недоступна в текущем контуре' }); return;
      }
      }
    }

    if (isActive !== undefined) {
      fields.isActive = !!isActive;
    }

    const updated = await updateChallenge(id, fields, workspaceForRequest(req));
    if (!updated) { res.status(404).json({ error: 'Челлендж не найден' }); return; }
    res.json(updated);
    logAudit('challenge_update', { challengeId: id, fields, workspace: workspaceForRequest(req) }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }
    const ok = await deleteChallenge(id, workspaceForRequest(req));
    if (!ok) { res.status(404).json({ error: 'Челлендж не найден' }); return; }
    res.json({ ok: true });
    logAudit('challenge_delete', { challengeId: id, workspace: workspaceForRequest(req) }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

// GET /api/challenges/:id/transactions — история ручных начислений
// по этому челленджу. Опирается на стабильный паттерн `Челлендж #{id}:`
// в note (см. admin/app.js: awardCoins/bulkAwardCoins).
router.get('/:id/transactions', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }
    const workspace = workspaceForRequest(req);
    const office = workspace === 'office';
    const { rows } = await pool.query<{
      id: number; createdAt: Date; amount: number; note: string | null;
      employeeId: number; employeeName: string; storeName: string | null;
      adminUsername: string | null;
    }>(
      `SELECT ct.id,
              ct.created_at AS "createdAt",
              ct.amount,
              ct.note,
              ct.employee_id AS "employeeId",
              e.name AS "employeeName",
              ${office ? 'COALESCE(os.name, s.name)' : 's.name'} AS "storeName",
              au.username AS "adminUsername"
       FROM coin_transactions ct
       JOIN employees e   ON e.id = ct.employee_id
       LEFT JOIN stores s ON s.id = e.store_id
       ${office ? `LEFT JOIN office_employee_memberships oem ON oem.employee_id = e.id
       LEFT JOIN stores os ON os.id = oem.office_store_id` : ''}
       LEFT JOIN admin_users au ON au.id = ct.created_by
       WHERE (ct.note LIKE $1 OR ct.note LIKE $2)
         AND ${office ? `(oem.employee_id IS NOT NULL OR s.workspace = 'office')` : `s.workspace = 'retail'`}
       ORDER BY ct.created_at DESC
       LIMIT 500`,
      // 1) Новый формат: `Челлендж #{id}: ...`
      // 2) Старый: `Челлендж: ...` — без id, может оставаться в исторических данных
      //    одного челленджа. Для совпадающих имён даст ложные положительные,
      //    но иначе старые транзакции в истории не появятся вообще.
      [`Челлендж #${id}:%`, `Челлендж: %`]
    );
    // Для запроса по id фильтруем «старый» формат: только если у челленджа
    // нет одноимённых конкурентов; иначе показываем только #id.
    const { rows: chRow } = await pool.query<{ name: string; sameNameCount: string }>(
      `SELECT sc.name,
              (SELECT COUNT(*)::text FROM seasonal_challenges WHERE name = sc.name) AS "sameNameCount"
       FROM seasonal_challenges sc WHERE sc.id = $1 AND sc.workspace = $2`,
      [id, workspace]
    );
    const challenge = chRow[0];
    if (!challenge) { res.status(404).json({ error: 'Челлендж не найден' }); return; }

    const filtered = rows.filter(r => {
      const note = r.note ?? '';
      if (note.startsWith(`Челлендж #${id}:`)) return true;
      // Старый формат принимаем только если имя челленджа уникально
      if (parseInt(challenge.sameNameCount, 10) === 1 && note.startsWith(`Челлендж: ${challenge.name}`)) return true;
      return false;
    });

    res.json({
      challengeName: challenge.name,
      total: filtered.length,
      coinsTotal: filtered.reduce((s, r) => s + (r.amount || 0), 0),
      uniqueEmployees: new Set(filtered.map(r => r.employeeId)).size,
      transactions: filtered,
    });
  } catch (err) { next(err); }
});

router.post('/:id/award/:employeeId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const challengeId = parseInt(req.params.id, 10);
    const employeeId  = parseInt(req.params.employeeId, 10);
    if (isNaN(challengeId) || isNaN(employeeId)) {
      res.status(400).json({ error: 'Неверный id' });
      return;
    }
    const workspace = workspaceForRequest(req);
    if (!(await areEmployeesInWorkspace([employeeId], workspace))) {
      res.status(403).json({ error: 'Сотрудник недоступен в текущем контуре' }); return;
    }
    const ok = await awardChallengeCard(employeeId, challengeId);
    res.json({ ok });
    if (ok) {
      logAudit('challenge_award', { challengeId, employeeId, workspace }, req.ip).catch(() => {});
    }
  } catch (err) { next(err); }
});

export default router;
