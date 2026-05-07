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
  heroName: string | null;
  coinReward: number;
  daysLeft: number;
  completed: boolean;
  cardAwarded: boolean;
  coinsAwarded: boolean;
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

  // Узнаём store_id сотрудника — нужен для фильтрации по store_ids челленджа
  const { rows: empRows } = await pool.query<{ storeId: number | null }>(
    `SELECT store_id AS "storeId" FROM employees WHERE id = $1`, [employeeId]
  );
  const employeeStoreId = empRows[0]?.storeId ?? null;

  const { rows } = await pool.query<{
    id: number; name: string; description: string; season: string;
    conditionDescription: string; startDate: string; endDate: string;
    heroName: string | null; coinReward: number; storeIds: number[] | null;
  }>(
    `SELECT sc.id, sc.name, sc.description, sc.season,
            sc.condition_description AS "conditionDescription",
            sc.start_date::text AS "startDate",
            sc.end_date::text AS "endDate",
            h.name AS "heroName",
            sc.coin_reward AS "coinReward",
            sc.store_ids  AS "storeIds"
     FROM seasonal_challenges sc
     LEFT JOIN heroes h ON h.id = sc.hero_id
     WHERE sc.is_active = true
       AND sc.start_date <= $1::date
       AND sc.end_date >= $1::date
       AND (sc.store_ids IS NULL OR $2::int = ANY(sc.store_ids))
     ORDER BY sc.start_date DESC
     LIMIT 1`,
    [today, employeeStoreId]
  );

  if (!rows[0]) return null;

  const ch = rows[0];

  let { rows: entryRows } = await pool.query<{ completedAt: string; cardAwarded: boolean; coinsAwarded: boolean }>(
    `SELECT completed_at::text AS "completedAt", card_awarded AS "cardAwarded", coins_awarded AS "coinsAwarded"
     FROM seasonal_challenge_entries
     WHERE challenge_id = $1 AND employee_id = $2`,
    [ch.id, employeeId]
  );

  // Если запись ещё не создана — пробуем завершить челлендж автоматически.
  // Условие: серия >= 7 И всего правильных ответов >= 15.
  if (!entryRows[0]) {
    try {
      const completed = await checkAndCompleteChallenge(employeeId, ch.id);
      if (completed) {
        const re = await pool.query<{ completedAt: string; cardAwarded: boolean; coinsAwarded: boolean }>(
          `SELECT completed_at::text AS "completedAt", card_awarded AS "cardAwarded", coins_awarded AS "coinsAwarded"
           FROM seasonal_challenge_entries
           WHERE challenge_id = $1 AND employee_id = $2`,
          [ch.id, employeeId]
        );
        entryRows = re.rows;
      }
    } catch (err) {
      console.error('[challenge] auto-complete failed:', err instanceof Error ? err.message : err);
    }
  }

  const entry = entryRows[0] ?? null;
  const endDate = new Date(ch.endDate);
  const daysLeft = Math.max(0, Math.ceil((endDate.getTime() - Date.now()) / 86_400_000));

  return {
    id: ch.id,
    name: ch.name,
    description: ch.description,
    season: ch.season,
    conditionDescription: ch.conditionDescription,
    startDate: ch.startDate,
    endDate: ch.endDate,
    heroName: ch.heroName,
    coinReward: ch.coinReward,
    daysLeft,
    completed: !!entry,
    cardAwarded: entry?.cardAwarded ?? false,
    coinsAwarded: entry?.coinsAwarded ?? false,
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

/**
 * Выдаёт сотруднику награду за выполненный челлендж: карточку (если задана)
 * и/или монеты (если coin_reward > 0). Идемпотентно — каждая часть награды
 * отслеживается отдельно через card_awarded / coins_awarded.
 *
 * Возвращает true если что-то было выдано (хоть часть награды).
 */
export async function awardChallengeReward(employeeId: number, challengeId: number): Promise<boolean> {
  const { rows: ch } = await pool.query<{ heroId: number | null; coinReward: number; name: string }>(
    `SELECT hero_id AS "heroId", coin_reward AS "coinReward", name FROM seasonal_challenges WHERE id = $1`,
    [challengeId]
  );
  if (!ch[0]) return false;

  const { rows: entry } = await pool.query<{ cardAwarded: boolean; coinsAwarded: boolean }>(
    `SELECT card_awarded AS "cardAwarded", coins_awarded AS "coinsAwarded"
     FROM seasonal_challenge_entries
     WHERE challenge_id = $1 AND employee_id = $2`,
    [challengeId, employeeId]
  );
  if (!entry[0]) return false; // нет записи о выполнении

  const needCard  = ch[0].heroId !== null && !entry[0].cardAwarded;
  const needCoins = ch[0].coinReward > 0 && !entry[0].coinsAwarded;
  if (!needCard && !needCoins) return false;

  const now = new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (needCard) {
      await client.query(
        `INSERT INTO employee_cards (employee_id, hero_id, source, year, month)
         VALUES ($1, $2, 'seasonal', $3, $4)`,
        [employeeId, ch[0].heroId, now.getFullYear(), now.getMonth() + 1]
      );
      await client.query(
        `UPDATE seasonal_challenge_entries SET card_awarded = true
         WHERE challenge_id = $1 AND employee_id = $2`,
        [challengeId, employeeId]
      );
    }

    if (needCoins) {
      const note = `Челлендж: ${ch[0].name}`;
      await client.query(
        `INSERT INTO coin_transactions (employee_id, amount, reason, note)
         VALUES ($1, $2, 'manual', $3)`,
        [employeeId, ch[0].coinReward, note]
      );
      await client.query(
        `UPDATE seasonal_challenge_entries SET coins_awarded = true
         WHERE challenge_id = $1 AND employee_id = $2`,
        [challengeId, employeeId]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return true;
}

/** Backward-compat алиас. */
export const awardChallengeCard = awardChallengeReward;

// Admin: list all challenges
export async function listChallenges() {
  // Подтягиваем имена точек одним запросом — не делаем N+1.
  const { rows } = await pool.query(
    `SELECT sc.*, h.name AS "heroName",
            sc.coin_reward AS "coinReward",
            sc.store_ids   AS "storeIds",
            COALESCE(
              (SELECT array_agg(s.name ORDER BY s.id)
               FROM stores s WHERE s.id = ANY(sc.store_ids)),
              ARRAY[]::text[]
            ) AS "storeNames",
            (SELECT COUNT(*) FROM seasonal_challenge_entries sce WHERE sce.challenge_id = sc.id) AS entries
     FROM seasonal_challenges sc
     LEFT JOIN heroes h ON h.id = sc.hero_id
     ORDER BY sc.year DESC, sc.start_date DESC`
  );
  return rows;
}

export async function deleteChallenge(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM seasonal_challenges WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export async function createChallenge(data: {
  name: string; description: string; season: string; year: number;
  heroId?: number; startDate: string; endDate: string; conditionDescription: string;
  coinReward?: number;
  storeIds?: number[] | null;
}) {
  const { rows } = await pool.query(
    `INSERT INTO seasonal_challenges
       (name, description, season, year, hero_id, start_date, end_date, condition_description, coin_reward, store_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *, coin_reward AS "coinReward", store_ids AS "storeIds"`,
    [data.name, data.description, data.season, data.year,
     data.heroId ?? null, data.startDate, data.endDate, data.conditionDescription,
     data.coinReward ?? 0,
     data.storeIds ?? null]
  );
  return rows[0];
}

export { currentSeason };
