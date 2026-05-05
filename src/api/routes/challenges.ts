import { Router, Request, Response, NextFunction } from 'express';
import { listChallenges, createChallenge, awardChallengeCard, deleteChallenge } from '../../services/challenge.service';
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
    const { name, description, season, year, heroId, startDate, endDate, conditionDescription } = req.body;
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
    const ch = await createChallenge({ name: name.trim(), description, season, year: yearNum, heroId, startDate, endDate, conditionDescription });
    res.status(201).json(ch);
    logAudit('challenge_create', { challengeId: ch.id, name, season, year: yearNum }, req.ip).catch(() => {});
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
