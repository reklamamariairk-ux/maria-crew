import { pool } from '../db/pool';
import { getAvailableCardCount, spendCards } from './card.service';
import { getBalance, spend as spendCoins } from './coin.service';
import type { Prize, StoreExchange } from '../types';

/** Все активные призы каталога */
export async function getPrizes(): Promise<Prize[]> {
  const { rows } = await pool.query<Prize>(
    `SELECT * FROM prizes WHERE is_active = true ORDER BY sort_order`
  );
  return rows;
}

/** Создаёт заявку на обмен, списывает карточки/монеты */
export async function requestExchange(
  employeeId: number,
  prizeId: number
): Promise<StoreExchange> {
  const { rows: prizeRows } = await pool.query<Prize>(
    `SELECT * FROM prizes WHERE id = $1 AND is_active = true`,
    [prizeId]
  );
  const prize = prizeRows[0];
  if (!prize) throw new Error('Приз не найден или недоступен');

  const [cardCount, coinBalance] = await Promise.all([
    getAvailableCardCount(employeeId),
    getBalance(employeeId),
  ]);

  if (prize.cardsRequired > 0 && cardCount < prize.cardsRequired) {
    throw new Error(
      `Недостаточно карточек: нужно ${prize.cardsRequired}, есть ${cardCount}`
    );
  }
  if (prize.coinsRequired > 0 && coinBalance < prize.coinsRequired) {
    throw new Error(
      `Недостаточно монет: нужно ${prize.coinsRequired}, есть ${coinBalance}`
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Списываем карточки
    let spentCardIds: number[] = [];
    if (prize.cardsRequired > 0) {
      spentCardIds = await spendCards(employeeId, prize.cardsRequired);
    }

    // Создаём запись обмена
    const { rows } = await client.query<StoreExchange>(
      `INSERT INTO store_exchanges
         (employee_id, prize_id, cards_spent, coins_spent, card_ids)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [employeeId, prizeId, prize.cardsRequired, prize.coinsRequired,
       spentCardIds.length > 0 ? spentCardIds : null]
    );
    const exchange = rows[0];

    // Списываем монеты
    if (prize.coinsRequired > 0) {
      await spendCoins({
        employeeId,
        amount: prize.coinsRequired,
        refId: exchange.id,
        note: `Обмен на "${prize.name}"`,
      });
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
     RETURNING *`,
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
    `SELECT se.*, p.name AS "prizeName"
     FROM store_exchanges se
     JOIN prizes p ON p.id = se.prize_id
     WHERE se.employee_id = $1
     ORDER BY se.created_at DESC
     LIMIT $2`,
    [employeeId, limit]
  );
  return rows;
}
