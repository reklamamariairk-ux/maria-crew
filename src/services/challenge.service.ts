import { pool } from '../db/pool';
import { irkutskDate } from './streak.service';

export interface ActiveChallenge {
  id: number;
  name: string;
  description: string;
  season: string;
  conditionDescription: string;
  startDate: string;
  endDate: string;
  heroName: string;
  daysLeft: number;
  completed: boolean;
  cardAwarded: boolean;
}

function currentSeason(): string {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

export async function getActiveChallenge(employeeId: number): Promise<ActiveChallenge | null> {
  const today = irkutskDate();

  const { rows } = await pool.query<{
    id: number; name: string; description: string; season: string;
    conditionDescription: string; startDate: string; endDate: string; heroName: string;
  }>(
    `SELECT sc.id, sc.name, sc.description, sc.season,
            sc.condition_description AS "conditionDescription",
            sc.start_date::text AS "startDate",
            sc.end_date::text AS "endDate",
            COALESCE(h.name, 'Лимитная карточка') AS "heroName"
     FROM seasonal_challenges sc
     LEFT JOIN heroes h ON h.id = sc.hero_id
     WHERE sc.is_active = true
       AND sc.start_date <= $1
       AND sc.end_date >= $1
     ORDER BY sc.start_date DESC
     LIMIT 1`,
    [today]
  );

  if (!rows[0]) return null;

  const ch = rows[0];

  const { rows: entryRows } = await pool.query<{ completedAt: string; cardAwarded: boolean }>(
    `SELECT completed_at::text AS "completedAt", card_awarded AS "cardAwarded"
     FROM seasonal_challenge_entries
     WHERE challenge_id = $1 AND employee_id = $2`,
    [ch.id, employeeId]
  );

  const entry = entryRows[0] ?? null;
  const endDate = new Date(ch.endDate);
  const daysLeft = Math.max(0, Math.ceil((endDate.getTime() - Date.now()) / 86_400_000));

  return {
    ...ch,
    daysLeft,
    completed: !!entry,
    cardAwarded: entry?.cardAwarded ?? false,
  };
}

export async function checkAndCompleteChallenge(employeeId: number, challengeId: number): Promise<boolean> {
  const { rows: ch } = await pool.query<{ season: string; year: number; hero_id: number }>(
    `SELECT season, year, hero_id FROM seasonal_challenges WHERE id = $1 AND is_active = true`,
    [challengeId]
  );
  if (!ch[0]) return false;

  // Check: streak >= 7 AND total correct quiz answers >= 15
  const [streakRows, quizRows] = await Promise.all([
    pool.query<{ maxStreak: string }>(
      `SELECT MAX(streak_day) AS "maxStreak" FROM daily_checkins WHERE employee_id = $1`,
      [employeeId]
    ),
    pool.query<{ correctCount: string }>(
      `SELECT COUNT(*) AS "correctCount" FROM quiz_attempts
       WHERE employee_id = $1 AND is_correct = true`,
      [employeeId]
    ),
  ]);

  const maxStreak = parseInt(streakRows.rows[0]?.maxStreak ?? '0', 10);
  const correctAnswers = parseInt(quizRows.rows[0]?.correctCount ?? '0', 10);

  if (maxStreak < 7 || correctAnswers < 15) return false;

  await pool.query(
    `INSERT INTO seasonal_challenge_entries (challenge_id, employee_id)
     VALUES ($1, $2)
     ON CONFLICT (challenge_id, employee_id) DO NOTHING`,
    [challengeId, employeeId]
  );

  return true;
}

export async function awardChallengeCard(employeeId: number, challengeId: number): Promise<boolean> {
  const { rows: ch } = await pool.query<{ heroId: number }>(
    `SELECT hero_id AS "heroId" FROM seasonal_challenges WHERE id = $1`,
    [challengeId]
  );
  if (!ch[0]?.heroId) return false;

  const now = new Date();

  await pool.query(
    `INSERT INTO employee_cards (employee_id, hero_id, source, year, month)
     VALUES ($1, $2, 'seasonal', $3, $4)
     ON CONFLICT DO NOTHING`,
    [employeeId, ch[0].heroId, now.getFullYear(), now.getMonth() + 1]
  );

  await pool.query(
    `UPDATE seasonal_challenge_entries SET card_awarded = true
     WHERE challenge_id = $1 AND employee_id = $2`,
    [challengeId, employeeId]
  );

  return true;
}

// Admin: list all challenges
export async function listChallenges() {
  const { rows } = await pool.query(
    `SELECT sc.*, h.name AS "heroName",
            (SELECT COUNT(*) FROM seasonal_challenge_entries sce WHERE sce.challenge_id = sc.id) AS entries
     FROM seasonal_challenges sc
     LEFT JOIN heroes h ON h.id = sc.hero_id
     ORDER BY sc.year DESC, sc.start_date DESC`
  );
  return rows;
}

export async function createChallenge(data: {
  name: string; description: string; season: string; year: number;
  heroId?: number; startDate: string; endDate: string; conditionDescription: string;
}) {
  const { rows } = await pool.query(
    `INSERT INTO seasonal_challenges
       (name, description, season, year, hero_id, start_date, end_date, condition_description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [data.name, data.description, data.season, data.year,
     data.heroId ?? null, data.startDate, data.endDate, data.conditionDescription]
  );
  return rows[0];
}

export { currentSeason };
