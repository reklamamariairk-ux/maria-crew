import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import { logAudit } from '../../services/audit.service';

const router = Router();

const PRIZE_TYPES = [
  'cake', 'certificate', 'cash', 'shift_choice', 'golden_badge',
  'coffee', 'discount', 'merch', 'break',
];

const MAX_ITEMS = 5;

interface ExternalItem {
  productId: string;
  name: string | null;
  qty: number;
}

/** Нормализует и валидирует входной массив items. Откидывает пустые productId,
 *  ограничивает qty целым >= 1, кэпирует длину MAX_ITEMS. Возвращает чистый
 *  массив или null если items не были переданы (тогда сохраняем то что есть). */
function normalizeItems(raw: unknown): ExternalItem[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return [];
  const out: ExternalItem[] = [];
  for (const r of raw.slice(0, MAX_ITEMS)) {
    if (!r || typeof r !== 'object') continue;
    const obj = r as { productId?: unknown; name?: unknown; qty?: unknown };
    const productId = String(obj.productId ?? '').trim();
    if (!productId) continue;
    const name = obj.name != null ? String(obj.name).trim() : '';
    const q = Number(obj.qty);
    const qty = Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1;
    out.push({ productId, name: name || null, qty });
  }
  return out;
}

/** Извлекает items из тела запроса: предпочитает externalItems, иначе
 *  собирает single-item из старых полей externalProductId/Name/Qty. */
function extractItems(body: {
  externalItems?: unknown;
  externalProductId?: string | null;
  externalProductName?: string | null;
  externalQty?: number;
}): ExternalItem[] | null {
  const normalized = normalizeItems(body.externalItems);
  if (normalized !== null) return normalized;
  // Back-compat: если пришли только old fields — конвертим в single-item.
  if (body.externalProductId !== undefined) {
    const pid = (body.externalProductId ?? '').toString().trim();
    if (!pid) return [];
    const name = (body.externalProductName ?? '').toString().trim() || null;
    const q = Number(body.externalQty);
    const qty = Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1;
    return [{ productId: pid, name, qty }];
  }
  return null; // не передали ни items, ни single — оставляем как есть
}

const PRIZE_SELECT = `
  SELECT id, name, description, prize_type AS "prizeType",
         cards_required AS "cardsRequired", coins_required AS "coinsRequired",
         is_active AS "isActive", sort_order AS "sortOrder",
         category_id           AS "categoryId",
         external_product_id   AS "externalProductId",
         external_product_name AS "externalProductName",
         external_qty          AS "externalQty",
         external_items        AS "externalItems"
`;

// GET /api/prizes — все призы (включая скрытые), с полями категории.
// Порядок: категория → цена ↑ → sort_order → id (как в витрине).
router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.description, p.prize_type AS "prizeType",
              p.cards_required AS "cardsRequired", p.coins_required AS "coinsRequired",
              p.is_active AS "isActive", p.sort_order AS "sortOrder",
              p.category_id AS "categoryId",
              c.name AS "categoryName", c.emoji AS "categoryEmoji",
              c.sort_order AS "categorySortOrder",
              p.external_product_id   AS "externalProductId",
              p.external_product_name AS "externalProductName",
              p.external_qty          AS "externalQty",
              p.external_items        AS "externalItems"
       FROM prizes p
       LEFT JOIN prize_categories c ON c.id = p.category_id
       ORDER BY COALESCE(c.sort_order, 9999), p.coins_required, p.cards_required, p.sort_order, p.id`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/prizes — создать
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as {
      name: string; description?: string; prizeType: string;
      cardsRequired?: number; coinsRequired?: number; sortOrder?: number;
      categoryId?: number | null;
      externalItems?: unknown;
      externalProductId?: string | null;
      externalProductName?: string | null;
      externalQty?: number;
    };
    if (!body.name || !body.name.trim()) { res.status(400).json({ error: 'name обязателен' }); return; }
    if (!PRIZE_TYPES.includes(body.prizeType)) {
      res.status(400).json({ error: `prizeType должен быть один из: ${PRIZE_TYPES.join(', ')}` });
      return;
    }
    const cards = Number.isFinite(body.cardsRequired) ? body.cardsRequired : 0;
    const coins = Number.isFinite(body.coinsRequired) ? body.coinsRequired : 0;
    if ((cards ?? 0) === 0 && (coins ?? 0) === 0) {
      res.status(400).json({ error: 'Укажи стоимость в карточках или монетах (или обе)' });
      return;
    }

    const items = extractItems(body) ?? [];
    // Old fields = items[0] (или NULL если items пуст). Так tryPushDelivery
    // и любой существующий код увидят первый товар без правок.
    const head = items[0] ?? null;

    const categoryId = Number.isFinite(body.categoryId as number) ? Number(body.categoryId) : null;
    const { rows } = await pool.query(
      `INSERT INTO prizes (name, description, prize_type, cards_required, coins_required, sort_order,
                           category_id, external_product_id, external_product_name, external_qty, external_items)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING ${PRIZE_SELECT.replace(/^[\s]*SELECT /, '')}`,
      [
        body.name.trim(), body.description?.trim() || null, body.prizeType,
        cards ?? 0, coins ?? 0, body.sortOrder ?? 999,
        categoryId,
        head?.productId ?? null,
        head?.name ?? null,
        head?.qty ?? 1,
        JSON.stringify(items),
      ]
    );
    res.status(201).json(rows[0]);
    logAudit('prize_create', { prizeId: rows[0].id, name: rows[0].name, itemCount: items.length }).catch(() => {});
  } catch (err) { next(err); }
});

// PUT /api/prizes/:id — обновить
router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as {
      name?: string; description?: string | null; prizeType?: string;
      cardsRequired?: number; coinsRequired?: number;
      isActive?: boolean; sortOrder?: number;
      categoryId?: number | null;
      externalItems?: unknown;
      externalProductId?: string | null;
      externalProductName?: string | null;
      externalQty?: number;
    };
    const sets: string[] = [];
    const vals: (string | number | boolean | null)[] = [];

    if (body.name !== undefined) { vals.push(body.name); sets.push(`name = $${vals.length}`); }
    if (body.description !== undefined) { vals.push(body.description ?? null); sets.push(`description = $${vals.length}`); }
    if (body.prizeType !== undefined) {
      if (!PRIZE_TYPES.includes(body.prizeType)) {
        res.status(400).json({ error: `prizeType должен быть один из: ${PRIZE_TYPES.join(', ')}` });
        return;
      }
      vals.push(body.prizeType); sets.push(`prize_type = $${vals.length}`);
    }
    if (body.cardsRequired !== undefined) { vals.push(body.cardsRequired); sets.push(`cards_required = $${vals.length}`); }
    if (body.coinsRequired !== undefined) { vals.push(body.coinsRequired); sets.push(`coins_required = $${vals.length}`); }
    if (body.isActive !== undefined) { vals.push(body.isActive); sets.push(`is_active = $${vals.length}`); }
    if (body.sortOrder !== undefined) { vals.push(body.sortOrder); sets.push(`sort_order = $${vals.length}`); }
    if (body.categoryId !== undefined) {
      const cid = Number.isFinite(body.categoryId as number) ? Number(body.categoryId) : null;
      vals.push(cid); sets.push(`category_id = $${vals.length}`);
    }

    // items берём либо из externalItems[], либо из старых полей (back-compat).
    // Если передали явно — пишем И в JSONB И в old fields (синхронизация).
    const items = extractItems(body);
    if (items !== null) {
      const head = items[0] ?? null;
      vals.push(head?.productId ?? null); sets.push(`external_product_id = $${vals.length}`);
      vals.push(head?.name ?? null);      sets.push(`external_product_name = $${vals.length}`);
      vals.push(head?.qty ?? 1);          sets.push(`external_qty = $${vals.length}`);
      vals.push(JSON.stringify(items));   sets.push(`external_items = $${vals.length}::jsonb`);
    }

    if (!sets.length) { res.status(400).json({ error: 'Нечего обновлять' }); return; }

    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE prizes SET ${sets.join(', ')}
       WHERE id = $${vals.length}
       RETURNING ${PRIZE_SELECT.replace(/^[\s]*SELECT /, '')}`,
      vals
    );
    if (!rows[0]) { res.status(404).json({ error: 'Приз не найден' }); return; }
    res.json(rows[0]);
    logAudit('prize_update', { prizeId: rows[0].id, changes: body }).catch(() => {});
  } catch (err) { next(err); }
});

// DELETE /api/prizes/:id — удалить (только если ни одной заявки не было)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: usage } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM store_exchanges WHERE prize_id = $1`,
      [id]
    );
    if (parseInt(usage[0]?.count ?? '0', 10) > 0) {
      res.status(409).json({
        error: 'Приз нельзя удалить — на него есть заявки. Сделай его «Скрытым» через переключатель.'
      });
      return;
    }
    const { rowCount } = await pool.query(`DELETE FROM prizes WHERE id = $1`, [id]);
    if (!rowCount) { res.status(404).json({ error: 'Приз не найден' }); return; }
    res.json({ ok: true });
    logAudit('prize_delete', { prizeId: id }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
