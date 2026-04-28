import { pool } from '../db/pool';
import type { Prize, StoreExchange } from '../types';

/** Все активные призы каталога */
export async function getPrizes(): Promise<Prize[]> {
  const { rows } = await pool.query<Prize>(
    `SELECT id, name, description, prize_type AS "prizeType",
            cards_required AS "cardsRequired", coins_required AS "coinsRequired",
            is_active AS "isActive", sort_order AS "sortOrder"
     FROM prizes WHERE is_active = true ORDER BY sort_order`
  );
  return rows;
}

/** Создаёт заявку на обмен, списывает карточки/монеты.
 *  Всё выполняется в одной транзакции с блокировкой строки employee,
 *  чтобы исключить двойное списание при параллельных запросах. */
export async function requestExchange(
  employeeId: number,
  prizeId: number
): Promise<StoreExchange> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Блокируем строку сотрудника — предотвращает concurrent exchanges
    await client.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [employeeId]);

    const { rows: prizeRows } = await client.query<Prize>(
      `SELECT id, name, description, prize_type AS "prizeType",
              cards_required AS "cardsRequired", coins_required AS "coinsRequired",
              is_active AS "isActive", sort_order AS "sortOrder"
       FROM prizes WHERE id = $1 AND is_active = true`,
      [prizeId]
    );
    const prize = prizeRows[0];
    if (!prize) throw new Error('Приз не найден или недоступен');

    // Проверяем карточки
    if (prize.cardsRequired > 0) {
      const { rows } = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM employee_cards WHERE employee_id = $1 AND is_spent = false`,
        [employeeId]
      );
      const cardCount = parseInt(rows[0].count, 10);
      if (cardCount < prize.cardsRequired) {
        throw new Error(`Недостаточно карточек: нужно ${prize.cardsRequired}, есть ${cardCount}`);
      }
    }

    // Проверяем монеты
    if (prize.coinsRequired > 0) {
      const { rows } = await client.query<{ balance: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS balance FROM coin_transactions WHERE employee_id = $1`,
        [employeeId]
      );
      const coinBalance = parseInt(rows[0].balance, 10);
      if (coinBalance < prize.coinsRequired) {
        throw new Error(`Недостаточно монет: нужно ${prize.coinsRequired}, есть ${coinBalance}`);
      }
    }

    // Списываем карточки (FIFO, MVP-карточки — последними)
    let spentCardIds: number[] = [];
    if (prize.cardsRequired > 0) {
      const { rows } = await client.query<{ id: number }>(
        `SELECT id FROM employee_cards
         WHERE employee_id = $1 AND is_spent = false
         ORDER BY is_mvp ASC, earned_at ASC
         LIMIT $2`,
        [employeeId, prize.cardsRequired]
      );
      spentCardIds = rows.map(r => r.id);
      await client.query(
        `UPDATE employee_cards SET is_spent = true WHERE id = ANY($1)`,
        [spentCardIds]
      );
    }

    // Создаём запись обмена
    const { rows } = await client.query<StoreExchange>(
      `INSERT INTO store_exchanges
         (employee_id, prize_id, cards_spent, coins_spent, card_ids)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, employee_id AS "employeeId", prize_id AS "prizeId",
                 cards_spent AS "cardsSpent", coins_spent AS "coinsSpent",
                 card_ids AS "cardIds", status, notes,
                 processed_by AS "processedBy", created_at AS "createdAt",
                 processed_at AS "processedAt"`,
      [employeeId, prizeId, prize.cardsRequired, prize.coinsRequired,
       spentCardIds.length > 0 ? spentCardIds : null]
    );
    const exchange = rows[0];

    // Списываем монеты
    if (prize.coinsRequired > 0) {
      await client.query(
        `INSERT INTO coin_transactions (employee_id, amount, reason, ref_id, note)
         VALUES ($1, $2, 'spend', $3, $4)`,
        [employeeId, -prize.coinsRequired, exchange.id, `Обмен на "${prize.name}"`]
      );
    }

    await client.query('COMMIT');
    return exchange;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Подтверждает/отклоняет заявку (для руководителя) */
export async function processExchange(
  exchangeId: number,
  status: 'approved' | 'rejected' | 'fulfilled',
  processedBy: number | null,
  notes?: string
): Promise<StoreExchange> {
  const { rows } = await pool.query<StoreExchange>(
    `UPDATE store_exchanges
     SET status = $1, processed_by = $2, notes = COALESCE($3, notes), processed_at = NOW()
     WHERE id = $4
     RETURNING id, employee_id AS "employeeId", prize_id AS "prizeId",
               cards_spent AS "cardsSpent", coins_spent AS "coinsSpent",
               card_ids AS "cardIds", status, notes,
               processed_by AS "processedBy", created_at AS "createdAt",
               processed_at AS "processedAt"`,
    [status, processedBy, notes ?? null, exchangeId]
  );
  if (!rows[0]) throw new Error('Заявка не найдена');

  // Если отклонили — возвращаем карточки И монеты (раньше монеты были вложены
  // в проверку карточек и теряли возврат при coin-only заявках)
  if (status === 'rejected') {
    const ex = rows[0];
    if (ex.cardIds && ex.cardIds.length > 0) {
      await pool.query(
        `UPDATE employee_cards SET is_spent = false WHERE id = ANY($1)`,
        [ex.cardIds]
      );
    }
    if (ex.coinsSpent > 0) {
      await pool.query(
        `INSERT INTO coin_transactions (employee_id, amount, reason, ref_id, note)
         VALUES ($1, $2, 'manual', $3, 'Возврат: заявка отклонена')`,
        [ex.employeeId, ex.coinsSpent, exchangeId]
      );
    }
  }

  return rows[0];
}

/** История обменов сотрудника */
export async function getExchangeHistory(
  employeeId: number,
  limit = 10
): Promise<(StoreExchange & { prizeName: string })[]> {
  const { rows } = await pool.query<StoreExchange & { prizeName: string }>(
    `SELECT se.id, se.employee_id AS "employeeId", se.prize_id AS "prizeId",
            se.cards_spent AS "cardsSpent", se.coins_spent AS "coinsSpent",
            se.card_ids AS "cardIds", se.status, se.notes,
            se.processed_by AS "processedBy", se.created_at AS "createdAt",
            se.processed_at AS "processedAt",
            p.name AS "prizeName"
     FROM store_exchanges se
     JOIN prizes p ON p.id = se.prize_id
     WHERE se.employee_id = $1
     ORDER BY se.created_at DESC
     LIMIT $2`,
    [employeeId, limit]
  );
  return rows;
}
