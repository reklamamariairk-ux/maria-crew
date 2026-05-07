import { Router, Request, Response, NextFunction } from 'express';
import { listChallenges, createChallenge, updateChallenge, awardChallengeCard, deleteChallenge } from '../../services/challenge.service';
import { logAudit } from '../../services/audit.service';

const router = Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await listChallenges());
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

    const ch = await createChallenge({
      name: name.trim(), description, season, year: yearNum, heroId,
      startDate, endDate, conditionDescription,
      coinReward: coinRewardNum,
      storeIds: storeIdsArr,
    });
    res.status(201).json(ch);
    logAudit('challenge_create', { challengeId: ch.id, name, season, year: yearNum, coinReward: coinRewardNum, storeIds: storeIdsArr }, req.ip).catch(() => {});
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
      }
    }

    if (isActive !== undefined) {
      fields.isActive = !!isActive;
    }

    const updated = await updateChallenge(id, fields);
    if (!updated) { res.status(404).json({ error: 'Челлендж не найден' }); return; }
    res.json(updated);
    logAudit('challenge_update', { challengeId: id, fields }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }
    const ok = await deleteChallenge(id);
    if (!ok) { res.status(404).json({ error: 'Челлендж не найден' }); return; }
    res.json({ ok: true });
    logAudit('challenge_delete', { challengeId: id }, req.ip).catch(() => {});
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
    const ok = await awardChallengeCard(employeeId, challengeId);
    res.json({ ok });
    if (ok) {
      logAudit('challenge_award', { challengeId, employeeId }, req.ip).catch(() => {});
    }
  } catch (err) { next(err); }
});

export default router;
