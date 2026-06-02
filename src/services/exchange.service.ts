import { pool } from '../db/pool';
import type { Prize, StoreExchange } from '../types';
import { createDeliveryDocument } from './oneCDelivery.service';

/** Расширенная информация о статусе доставки (для админки). */
export interface ExchangeWithDelivery extends StoreExchange {
  externalDocId?: string | null;
  externalDocStatus?: 'pending' | 'created' | 'failed' | 'mock_created' | null;
  externalDocError?: string | null;
  externalDocAt?: Date | null;
}

/** Все активные призы каталога — с полями категории для группировки витрины.
 *  Порядок: категория (по её sort_order) → цена ↑ → sort_order → id.
 *  Финальную сортировку «по цене внутри категории» под выбранную валюту
 *  делает клиент (карточки vs монеты), здесь — стабильный базовый порядок. */
export async function getPrizes(): Promise<Prize[]> {
  const { rows } = await pool.query<Prize>(
    `SELECT p.id, p.name, p.description, p.prize_type AS "prizeType",
            p.cards_required AS "cardsRequired", p.coins_required AS "coinsRequired",
            p.is_active AS "isActive", p.sort_order AS "sortOrder",
            p.category_id AS "categoryId",
            c.name AS "categoryName", c.emoji AS "categoryEmoji",
            c.sort_order AS "categorySortOrder"
     FROM prizes p
     LEFT JOIN prize_categories c ON c.id = p.category_id
     WHERE p.is_active = true
     ORDER BY COALESCE(c.sort_order, 9999), p.coins_required, p.cards_required, p.sort_order, p.id`
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
         (employee_id, prize_id, cards_spent, coins_spent, card_ids, prize_name, prize_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, employee_id AS "employeeId", prize_id AS "prizeId",
                 cards_spent AS "cardsSpent", coins_spent AS "coinsSpent",
                 card_ids AS "cardIds", status, notes,
                 processed_by AS "processedBy", created_at AS "createdAt",
                 processed_at AS "processedAt"`,
      [employeeId, prizeId, prize.cardsRequired, prize.coinsRequired,
       spentCardIds.length > 0 ? spentCardIds : null, prize.name, prize.prizeType]
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

/** Подтверждает/отклоняет заявку (для руководителя).
 *
 *  Если статус = approved и у приза есть external_product_id, дополнительно
 *  пытается создать документ выдачи в 1С УПП через oneCDelivery.service.
 *  Делается уже ПОСЛЕ commit транзакции approve, чтобы:
 *   - не держать row-lock на время сетевого вызова (до 45с с ретраями)
 *   - approve был зафиксирован, даже если 1С недоступен (можно retry'нуть позже)
 *
 *  При успехе 1С — статус автоматически переходит approved → fulfilled
 *  (отдельным UPDATE), пишется external_doc_id.
 *  При неудаче — статус остаётся approved, external_doc_status='failed',
 *  ошибка в external_doc_error. Админ видит красный значок и кнопку «Повторить».
 */
export async function processExchange(
  exchangeId: number,
  status: 'approved' | 'rejected' | 'fulfilled',
  processedBy: number | null,
  notes?: string
): Promise<ExchangeWithDelivery> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Блокируем строку и читаем текущий статус — нельзя обрабатывать уже
    // обработанную заявку (например, два админа параллельно или последовательно
    // нажали «Отклонить» и «Выдать» — иначе ресурсы и приз раздадутся вместе).
    const { rows: current } = await client.query<{ status: string }>(
      `SELECT status FROM store_exchanges WHERE id = $1 FOR UPDATE`,
      [exchangeId]
    );
    if (!current[0]) throw new Error('Заявка не найдена');
    // Финальные состояния — менять нельзя. approved — промежуточный, можно довести до fulfilled.
    if (current[0].status === 'fulfilled' || current[0].status === 'rejected') {
      throw new Error(`Заявка уже обработана (статус: ${current[0].status === 'fulfilled' ? 'выдана' : 'отклонена'})`);
    }

    const { rows } = await client.query<ExchangeWithDelivery>(
      `UPDATE store_exchanges
       SET status = $1, processed_by = $2, notes = COALESCE($3, notes), processed_at = NOW()
       WHERE id = $4
       RETURNING id, employee_id AS "employeeId", prize_id AS "prizeId",
                 cards_spent AS "cardsSpent", coins_spent AS "coinsSpent",
                 card_ids AS "cardIds", status, notes,
                 processed_by AS "processedBy", created_at AS "createdAt",
                 processed_at AS "processedAt",
                 external_doc_id AS "externalDocId",
                 external_doc_status AS "externalDocStatus",
                 external_doc_error AS "externalDocError",
                 external_doc_at AS "externalDocAt"`,
      [status, processedBy, notes ?? null, exchangeId]
    );
    if (!rows[0]) throw new Error('Заявка не найдена');

    // При отклонении — возврат карточек и монет в одной транзакции
    if (status === 'rejected') {
      const ex = rows[0];
      if (ex.cardIds && ex.cardIds.length > 0) {
        await client.query(
          `UPDATE employee_cards SET is_spent = false WHERE id = ANY($1)`,
          [ex.cardIds]
        );
      }
      if (ex.coinsSpent > 0) {
        await client.query(
          `INSERT INTO coin_transactions (employee_id, amount, reason, ref_id, note)
           VALUES ($1, $2, 'manual', $3, 'Возврат: заявка отклонена')`,
          [ex.employeeId, ex.coinsSpent, exchangeId]
        );
      }
    }

    await client.query('COMMIT');

    // Push в 1С — только при approve и только если у приза задан товар.
    // Делается после COMMIT, чтобы не держать lock на время сетевого вызова.
    if (status === 'approved') {
      return await tryPushDelivery(exchangeId, rows[0]);
    }
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Пытается создать документ выдачи в 1С для уже-approved заявки.
 *  Используется внутри processExchange после approve и из retry-эндпоинта.
 *  Обновляет store_exchanges (external_doc_*) и при успехе переводит в fulfilled. */
export async function tryPushDelivery(
  exchangeId: number,
  currentExchange?: ExchangeWithDelivery
): Promise<ExchangeWithDelivery> {
  // Загружаем prize.external_items, employee.phone — если items пуст или
  // phone не задан, выдача в 1С невозможна.
  const { rows: meta } = await pool.query<{
    employeeId: number;
    phone: string | null;
    externalItems: Array<{ productId: string; name: string | null; qty: number }>;
    prizeName: string;
    currentStatus: string;
  }>(
    `SELECT se.employee_id   AS "employeeId",
            e.phone          AS "phone",
            COALESCE(p.external_items, '[]'::jsonb) AS "externalItems",
            COALESCE(p.name, se.prize_name) AS "prizeName",
            se.status        AS "currentStatus"
     FROM store_exchanges se
     JOIN employees e ON e.id = se.employee_id
     LEFT JOIN prizes p ON p.id = se.prize_id
     WHERE se.id = $1`,
    [exchangeId]
  );
  if (!meta[0]) throw new Error('Заявка не найдена при попытке push в 1С');
  const m = meta[0];
  const items = Array.isArray(m.externalItems) ? m.externalItems : [];

  // Нет привязки товаров — выдача в 1С не нужна. Возвращаем текущее состояние.
  if (items.length === 0) {
    return currentExchange ?? (await getExchangeById(exchangeId));
  }
  // Нет телефона у сотрудника — без него 1С не найдёт карту. Помечаем как failed
  // с понятной причиной, админ исправит phone в карточке сотрудника и нажмёт retry.
  if (!m.phone) {
    await pool.query(
      `UPDATE store_exchanges
         SET external_doc_status = 'failed',
             external_doc_error  = $2,
             external_doc_at     = NOW()
       WHERE id = $1`,
      [exchangeId, 'У сотрудника не указан телефон — добавьте phone в карточке и нажмите «Повторить»']
    );
    return await getExchangeById(exchangeId);
  }

  // Зовём 1С (или mock) по одному вызову на каждый item. externalRef:
  // для single-item совместимо со старым форматом (просто exchangeId),
  // для multi-item — "<exchangeId>:<idx>" чтобы 1С различал документы.
  type ItemResult = {
    idx: number;
    productId: string;
    ok: boolean;
    status: string;
    documentId?: string;
    error?: string;
  };
  const results: ItemResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const externalRef = items.length === 1 ? exchangeId : `${exchangeId}:${i}`;
    const r = await createDeliveryDocument({
      phone: m.phone,
      productId: it.productId,
      qty: it.qty ?? 1,
      externalRef,
      note: items.length === 1
        ? `${m.prizeName} (заявка #${exchangeId})`
        : `${m.prizeName} — позиция ${i + 1}/${items.length}: ${it.name ?? it.productId} (заявка #${exchangeId})`,
    });
    results.push({
      idx: i,
      productId: it.productId,
      ok: !!(r.ok && r.documentId),
      status: r.status,
      documentId: r.documentId,
      error: r.error,
    });
  }

  // Агрегируем результат: все ok → fulfilled+created, иначе failed с описанием.
  const allOk = results.every(r => r.ok);
  const docPayload = items.length === 1
    ? results[0].documentId ?? null
    : JSON.stringify(results.map(r => ({ idx: r.idx, productId: r.productId, docId: r.documentId, status: r.status, error: r.error })));
  const statusValue = allOk ? results[0].status : 'failed';
  const errorValue = allOk ? null : results.filter(r => !r.ok).map(r => `[${r.productId}] ${r.error ?? 'ошибка'}`).join('; ');

  if (allOk) {
    await pool.query(
      `UPDATE store_exchanges
         SET status              = 'fulfilled',
             external_doc_id     = $2,
             external_doc_status = $3,
             external_doc_error  = NULL,
             external_doc_at     = NOW()
       WHERE id = $1`,
      [exchangeId, docPayload, statusValue]
    );
  } else {
    await pool.query(
      `UPDATE store_exchanges
         SET external_doc_id     = $2,
             external_doc_status = 'failed',
             external_doc_error  = $3,
             external_doc_at     = NOW()
       WHERE id = $1`,
      [exchangeId, docPayload, errorValue]
    );
  }
  return await getExchangeById(exchangeId);
}

async function getExchangeById(exchangeId: number): Promise<ExchangeWithDelivery> {
  const { rows } = await pool.query<ExchangeWithDelivery>(
    `SELECT id, employee_id AS "employeeId", prize_id AS "prizeId",
            cards_spent AS "cardsSpent", coins_spent AS "coinsSpent",
            card_ids AS "cardIds", status, notes,
            processed_by AS "processedBy", created_at AS "createdAt",
            processed_at AS "processedAt",
            external_doc_id AS "externalDocId",
            external_doc_status AS "externalDocStatus",
            external_doc_error AS "externalDocError",
            external_doc_at AS "externalDocAt"
     FROM store_exchanges WHERE id = $1`,
    [exchangeId]
  );
  if (!rows[0]) throw new Error('Заявка не найдена');
  return rows[0];
}


/** История обменов сотрудника */
export async function getExchangeHistory(
  employeeId: number,
  limit = 10
): Promise<(StoreExchange & { prizeName: string; prizeType: string })[]> {
  const { rows } = await pool.query<StoreExchange & { prizeName: string; prizeType: string }>(
    `SELECT se.id, se.employee_id AS "employeeId", se.prize_id AS "prizeId",
            se.cards_spent AS "cardsSpent", se.coins_spent AS "coinsSpent",
            se.card_ids AS "cardIds", se.status, se.notes,
            se.processed_by AS "processedBy", se.created_at AS "createdAt",
            se.processed_at AS "processedAt",
            COALESCE(p.name, se.prize_name) AS "prizeName",
            COALESCE(p.prize_type::text, se.prize_type) AS "prizeType"
     FROM store_exchanges se
     LEFT JOIN prizes p ON p.id = se.prize_id
     WHERE se.employee_id = $1
     ORDER BY se.created_at DESC
     LIMIT $2`,
    [employeeId, limit]
  );
  return rows;
}
