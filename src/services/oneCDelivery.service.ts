// Push в 1С УПП — создание документа выдачи товара клиенту по телефону.
// Используется при одобрении заявки на приз, если у приза привязан товар 1С.
//
// Mock-режим: если ONE_C_DELIVERY_URL не задан, возвращает синтетический
// documentId со статусом 'mock_created'. Это позволяет прогонять end-to-end
// flow до того, как Hellstaff закроет правки BSL (см. session_log 2026-05-15
// и memo sales-dashboard). Когда endpoint в УПП появится — добавить переменную
// в env и логика автоматически переключится.

export interface DeliveryRequest {
  phone: string;
  productId: string;
  qty: number;
  /** Идемпотентный ключ — обычно store_exchanges.id. 1С при повторном вызове
   *  с тем же externalRef обязан вернуть тот же documentId, а не создать дубль. */
  externalRef: string | number;
  note?: string;
}

export type DeliveryStatus = 'created' | 'mock_created' | 'failed';

export interface DeliveryResult {
  ok: boolean;
  status: DeliveryStatus;
  documentId?: string;
  error?: string;
}

const ONE_C_URL = (process.env.ONE_C_DELIVERY_URL ?? '').trim();
const ONE_C_AUTH = (process.env.ONE_C_DELIVERY_AUTH ?? '').trim();
const ONE_C_TIMEOUT_MS = 15_000;

export function isOneCConfigured(): boolean {
  return ONE_C_URL.length > 0;
}

export async function createDeliveryDocument(req: DeliveryRequest): Promise<DeliveryResult> {
  if (!ONE_C_URL) {
    // Mock: эндпоинт в УПП ещё не зарегистрирован. Симулируем успех,
    // чтобы остальная цепочка (статус заявки, уведомления, аудит) тестировалась.
    return {
      ok: true,
      status: 'mock_created',
      documentId: `mock-${req.externalRef}-${Date.now()}`,
    };
  }

  const body = {
    phone: req.phone,
    productId: req.productId,
    qty: req.qty,
    externalRef: String(req.externalRef),
    note: req.note ?? null,
  };

  let lastError = 'неизвестная ошибка';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const tmr = setTimeout(() => ctrl.abort(), ONE_C_TIMEOUT_MS);
      const res = await fetch(ONE_C_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ONE_C_AUTH
            ? { Authorization: `Basic ${Buffer.from(ONE_C_AUTH).toString('base64')}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(tmr);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastError = `HTTP ${res.status}: ${text.slice(0, 200) || '(пустое тело)'}`;
        // 4xx — валидационная ошибка от 1С (нет карты, нет товара). Не ретраим.
        if (res.status >= 400 && res.status < 500) {
          return { ok: false, status: 'failed', error: lastError };
        }
        // 5xx — может быть кратковременная проблема, ретраим с back-off.
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }

      const json = (await res.json()) as {
        ok?: boolean;
        documentId?: string;
        error?: string;
      };
      if (json.ok === false || !json.documentId) {
        return {
          ok: false,
          status: 'failed',
          error: json.error ?? 'ответ 1С без documentId',
        };
      }
      return { ok: true, status: 'created', documentId: json.documentId };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  return { ok: false, status: 'failed', error: `после 3 попыток: ${lastError}` };
}
