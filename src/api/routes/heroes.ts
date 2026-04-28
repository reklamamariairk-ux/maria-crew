import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';

const router = Router();

// GET /api/heroes — все герои (основные + лимитные) для пикера в админке
router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, is_limited AS "isLimited", season, sort_order AS "sortOrder"
       FROM heroes
       ORDER BY is_limited, sort_order`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
