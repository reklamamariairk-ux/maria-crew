import { Router, Request, Response, NextFunction } from 'express';
import { listChallenges, createChallenge, awardChallengeCard } from '../../services/challenge.service';

const router = Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await listChallenges());
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, description, season, year, heroId, startDate, endDate, conditionDescription } = req.body;
    if (!name || !season || !year || !startDate || !endDate) {
      res.status(400).json({ error: 'name, season, year, startDate, endDate обязательны' });
      return;
    }
    const ch = await createChallenge({ name, description, season, year, heroId, startDate, endDate, conditionDescription });
    res.status(201).json(ch);
  } catch (err) { next(err); }
});

router.post('/:id/award/:employeeId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ok = await awardChallengeCard(parseInt(req.params.employeeId), parseInt(req.params.id));
    res.json({ ok });
  } catch (err) { next(err); }
});

export default router;
