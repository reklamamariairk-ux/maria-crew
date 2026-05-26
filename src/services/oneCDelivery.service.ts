// Push в 1С УПП — создание документа выдачи товара клиенту по телефону.
// Используется при одобрении заявки на приз, если у приза привязан товар 1С.
//
// Mock-режим: если ONE_C_DELIVERY_URL не задан, возвращает синтетический
// documentId со статусом 'mock_created'. Это позволяет прогонять end-to-end
// flow до того, как Hellstaff закроет правки BSL (см. session_log 2026-05-15
// и memo sales-dashboard). Когда endpoint в УПП появится — добавить переменную
// в env и логика автоматически переключится.
//
// Формат телефона: 1С хранит дисконтные карты в формате 8XXXXXXXXXX
// (89...) с ведущей 8, а у нас в employees.phone_normalized всегда
// формат 79XXXXXXXXXX (с 7). Конвертируем в normalizePhoneFor1C().

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

/** Конвертирует телефон в формат 1С: 11 цифр с ведущей 8 (89XXXXXXXXX).
 *  Принимает любой ввод (+79..., 79..., 89..., с пробелами/скобками/дефисами).
 *  Валидирует что это российский мобильный (после префикса первая цифра = 9).
 *  Возвращает 11-значную строку либо null если телефон не валиден. */
export function normalizePhoneFor1C(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  // Снимаем международный префикс если есть: 7900... → 900..., 8900... → 900...
  let rest: string;
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
    rest = digits.slice(1);
  } else if (digits.length === 10) {
    rest = digits;
  } else {
    return null; // невалидный размер
  }
  if (rest.length !== 10) return null;
  // Российский мобильный — всегда начинается с 9. Городские/иностранные
  // в 1С Маши не зарегистрированы как дисконтные карты, отбрасываем.
  if (rest[0] !== '9') return null;
  return '8' + rest;
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

  // Конвертируем телефон в формат 1С (89XXXXXXXXX). Если телефон невалиден —
  // не идём в 1С, сразу возвращаем failed с понятной ошибкой.
  const phone1C = normalizePhoneFor1C(req.phone);
  if (!phone1C) {
    return {
      ok: false,
      status: 'failed',
      error: `некорректный формат телефона: ${req.phone}`,
    };
  }

  const body = {
    phone: phone1C,
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
