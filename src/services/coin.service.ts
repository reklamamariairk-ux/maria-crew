import { pool } from '../db/pool';
import type { CoinReason, CoinTransaction } from '../types';

// Суммы начисления/списания по причинам (Maria Crew v3.0)
export const COIN_AMOUNTS: Record<Exclude<CoinReason, 'spend' | 'manual'>, number> = {
  // Начисления
  checklist_day:       1,
  review:              3,
  cake_order:          2,   // устарело, оставлено для обратной совместимости
  substitution:        5,
  mentoring:           10,
  idea:                5,
  training_meeting:    5,
  knowledge_applied:   3,
  plan_100:            2,
  plan_105:            5,
  quiz:                1,
  checkin:             1,
  // Списания (отрицательные)
  bad_review:          -5,
  dirty_store:         -5,
  training_resistance: -3,
};

/** Текущий баланс монет сотрудника */
export async function getBalance(employeeId: number): Promise<number> {
  const { rows } = await pool.query<{ balance: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS balance
     FROM coin_transactions
     WHERE employee_id = $1`,
    [employeeId]
  );
  return parseInt(rows[0].balance, 10);
}

/** Проверяет, хватает ли монет */
export async function canAfford(employeeId: number, amount: number): Promise<boolean> {
  const balance = await getBalance(employeeId);
  return balance >= amount;
}

/**
 * Начисляет или списывает монеты сотруднику.
 * Для стандартных причин сумма берётся из COIN_AMOUNTS.
 * Для 'manual' сумму нужно передать явно.
 * Баланс не уходит ниже 0: если списание превышает баланс, списывается ровно столько, сколько есть.
 */
export async function earn(params: {
  employeeId: number;
  reason: Exclude<CoinReason, 'spend'>;
  amount?: number;
  createdBy?: number;
  refId?: number;
  note?: string;
}): Promise<CoinTransaction> {
  const { employeeId, reason, createdBy, refId, note } = params;

  let amount =
    params.amount !== undefined
      ? params.amount
      : COIN_AMOUNTS[reason as keyof typeof COIN_AMOUNTS];

  if (amount === 0) throw new Error('Сумма не может быть равна нулю');

  // Для отрицательных операций: баланс не уходит ниже 0
  if (amount < 0) {
    const balance = await getBalance(employeeId);
    if (balance === 0) {
      throw new Error('Нечего списывать: баланс уже нулевой');
    }
    amount = -Math.min(Math.abs(amount), balance);
  }

  const { rows } = await pool.query<CoinTransaction>(
    `INSERT INTO coin_transactions (employee_id, amount, reason, ref_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [employeeId, amount, reason, refId ?? null, note ?? null, createdBy ?? null]
  );
  return rows[0];
}

/**
 * Списывает монеты при обмене в Maria Store.
 * Проверяет баланс перед списанием.
 */
export async function spend(params: {
  employeeId: number;
  amount: number;
  refId?: number;
  note?: string;
}): Promise<CoinTransaction> {
  const { employeeId, amount, refId, note } = params;
  if (amount <= 0) throw new Error('Сумма списания должна быть положительной');

  const balance = await getBalance(employeeId);
  if (balance < amount) {
    throw new Error(`Недостаточно монет: нужно ${amount}, на балансе ${balance}`);
  }

  const { rows } = await pool.query<CoinTransaction>(
    `INSERT INTO coin_transactions (employee_id, amount, reason, ref_id, note)
     VALUES ($1, $2, 'spend', $3, $4)
     RETURNING *`,
    [employeeId, -amount, refId ?? null, note ?? null]
  );
  return rows[0];
}

/** История транзакций сотрудника (последние `limit` записей) */
export async function getHistory(
  employeeId: number,
  limit = 20
): Promise<CoinTransaction[]> {
  const { rows } = await pool.query<CoinTransaction>(
    `SELECT * FROM coin_transactions
     WHERE employee_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [employeeId, limit]
  );
  return rows;
}

/** Статистика монет за месяц (сколько заработано, сколько потрачено).
 *  Месяц считается по Иркутскому времени (UTC+8) — иначе транзакции в начале/конце
 *  месяца могут уехать в соседний месяц по UTC. */
export async function getMonthlySummary(
  employeeId: number,
  year: number,
  month: number
): Promise<{ earned: number; spent: number; net: number }> {
  const { rows } = await pool.query<{ earned: string; spent: string }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)::text AS earned,
       COALESCE(ABS(SUM(amount) FILTER (WHERE amount < 0)), 0)::text AS spent
     FROM coin_transactions
     WHERE employee_id = $1
       AND EXTRACT(YEAR  FROM created_at AT TIME ZONE 'Asia/Irkutsk') = $2
       AND EXTRACT(MONTH FROM created_at AT TIME ZONE 'Asia/Irkutsk') = $3`,
    [employeeId, year, month]
  );
  const earned = parseInt(rows[0].earned, 10);
  const spent  = parseInt(rows[0].spent, 10);
  return { earned, spent, net: earned - spent };
}
