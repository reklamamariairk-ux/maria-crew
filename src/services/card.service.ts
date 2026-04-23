import { pool } from '../db/pool';
import type {
  CardAwardItem,
  CardSource,
  CollectionSummary,
  EmployeeCard,
  MonthlyMetrics,
} from '../types';

// Количество основных (не лимитных) героев
const MAIN_HEROES_COUNT = 12;

/**
 * По заполненным метрикам определяет список причин для начисления карточек.
 * Чистая функция — не обращается к БД.
 */
export function calcCardAwards(metrics: MonthlyMetrics): CardAwardItem[] {
  const awards: CardAwardItem[] = [];

  if (metrics.mysteryShopperScore !== null && metrics.mysteryShopperScore >= 90) {
    awards.push({ source: 'mystery_shopper', isMvp: false });
  }

  // Максимум 2 карточки за отзывы в месяц
  const reviewCards = Math.min(metrics.reviewsCount, 2);
  for (let i = 0; i < reviewCards; i++) {
    awards.push({ source: 'review', isMvp: false });
  }

  if (metrics.checklistPercent !== null && metrics.checklistPercent >= 100) {
    awards.push({ source: 'checklist', isMvp: false });
  }

  if (metrics.revenuePercent !== null && metrics.revenuePercent >= 105) {
    awards.push({ source: 'plan', isMvp: false });
  }

  if (metrics.isMvp) {
    awards.push({ source: 'mvp', isMvp: true });
  }

  return awards;
}

/** Выбирает случайного основного героя (1..MAIN_HEROES_COUNT) */
function randomHeroId(): number {
  return Math.floor(Math.random() * MAIN_HEROES_COUNT) + 1;
}

/**
 * Начисляет карточки сотруднику за месяц на основе рассчитанных awards.
 * Каждый вызов идемпотентен для конкретного source в рамках одного месяца —
 * если карточка с таким source уже есть, не дублирует.
 */
export async function awardCards(
  employeeId: number,
  year: number,
  month: number,
  awards: CardAwardItem[]
): Promise<EmployeeCard[]> {
  if (awards.length === 0) return [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Источники, уже начисленные в этом месяце
    const { rows: existing } = await client.query<{ source: CardSource }>(
      `SELECT source FROM employee_cards
       WHERE employee_id = $1 AND year = $2 AND month = $3`,
      [employeeId, year, month]
    );
    const existingSources = new Set(existing.map(r => r.source));

    const inserted: EmployeeCard[] = [];

    for (const award of awards) {
      // review может быть до 2 раз — считаем уже вставленные в этой транзакции
      if (award.source !== 'review' && existingSources.has(award.source)) continue;

      const heroId = randomHeroId();
      const { rows } = await client.query<EmployeeCard>(
        `INSERT INTO employee_cards (employee_id, hero_id, is_mvp, source, year, month)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [employeeId, heroId, award.isMvp, award.source, year, month]
      );
      inserted.push(rows[0]);

      if (award.source === 'review') {
        // review не уникален по source — продолжаем, но не добавляем в set
      } else {
        existingSources.add(award.source);
      }
    }

    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Начисляет командный бонус (team_bonus) всем сотрудникам точки */
export async function awardTeamBonus(
  storeId: number,
  year: number,
  month: number
): Promise<void> {
  const { rows: employees } = await pool.query<{ id: number }>(
    `SELECT id FROM employees WHERE store_id = $1 AND is_active = true`,
    [storeId]
  );

  await Promise.all(
    employees.map(e =>
      awardCards(e.id, year, month, [{ source: 'team_bonus', isMvp: false }])
    )
  );
}

/** Коллекция карточек сотрудника */
export async function getCollection(employeeId: number): Promise<CollectionSummary> {
  const { rows } = await pool.query<EmployeeCard & { heroName: string }>(
    `SELECT ec.*, h.name AS "heroName"
     FROM employee_cards ec
     JOIN heroes h ON h.id = ec.hero_id
     WHERE ec.employee_id = $1
     ORDER BY ec.earned_at DESC`,
    [employeeId]
  );

  const available = rows.filter(c => !c.isSpent);
  const uniqueHeroes = new Set(
    rows.filter(c => !c.heroId).length === 0
      ? rows.filter(c => !c.isSpent || true).map(c => c.heroId)
      : []
  );

  // Считаем уникальных основных героев среди всех карточек (включая потраченные)
  const { rows: heroRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT ec.hero_id) AS count
     FROM employee_cards ec
     JOIN heroes h ON h.id = ec.hero_id
     WHERE ec.employee_id = $1 AND h.is_limited = false`,
    [employeeId]
  );

  const uniqueHeroCount = parseInt(heroRows[0]?.count ?? '0', 10);

  return {
    cards: rows,
    uniqueHeroes: uniqueHeroCount,
    totalCards: rows.length,
    availableCards: available.length,
    hasFullCollection: uniqueHeroCount >= MAIN_HEROES_COUNT,
  };
}

/** Количество доступных (не потраченных) карточек */
export async function getAvailableCardCount(employeeId: number): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM employee_cards
     WHERE employee_id = $1 AND is_spent = false`,
    [employeeId]
  );
  return parseInt(rows[0].count, 10);
}

/**
 * Списывает `count` карточек при обмене в Maria Store.
 * Возвращает ID списанных карточек.
 * Выбирает самые старые (FIFO) — MVP-карточки в последнюю очередь.
 */
export async function spendCards(
  employeeId: number,
  count: number
): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM employee_cards
     WHERE employee_id = $1 AND is_spent = false
     ORDER BY is_mvp ASC, earned_at ASC
     LIMIT $2`,
    [employeeId, count]
  );

  if (rows.length < count) {
    throw new Error(`Недостаточно карточек: нужно ${count}, доступно ${rows.length}`);
  }

  const ids = rows.map(r => r.id);
  await pool.query(
    `UPDATE employee_cards SET is_spent = true WHERE id = ANY($1)`,
    [ids]
  );

  return ids;
}
