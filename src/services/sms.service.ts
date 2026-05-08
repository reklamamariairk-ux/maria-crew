// SMS-уведомления через SMS.ru — самый популярный российский шлюз.
// Бесплатных SMS даёт 10 на регистрацию + дальше ~₽1.5/SMS.
//
// Активируется через env SMSRU_API_KEY. Без ключа sendSms() возвращает false
// (no-op) — приложение продолжает работать, просто без SMS-канала.
//
// API doc: https://sms.ru/?panel=api&subpanel=method&show=sms/send

import { normalizePhone } from './employeeAuth.service';

export interface SmsResult {
  ok: boolean;
  status?: string;
  error?: string;
}

export async function sendSms(phone: string, text: string): Promise<SmsResult> {
  const apiKey = process.env.SMSRU_API_KEY;
  if (!apiKey) {
    console.log(`[sms] no SMSRU_API_KEY — would send to ${phone}: "${text.slice(0, 40)}..."`);
    return { ok: false, error: 'SMS-шлюз не настроен' };
  }

  const phoneNorm = normalizePhone(phone);
  if (phoneNorm.length !== 11) {
    return { ok: false, error: 'Неверный формат телефона' };
  }

  const params = new URLSearchParams({
    api_id: apiKey,
    to: phoneNorm,
    msg: text,
    json: '1',
  });

  try {
    const res = await fetch('https://sms.ru/sms/send?' + params.toString(), {
      method: 'GET',
      // SMS-шлюз быстрый, но не моментальный — 10 секунд таймаут разумно
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json() as {
      status: string;
      status_code: number;
      sms?: Record<string, { status: string; status_code: number; status_text?: string }>;
    };

    if (data.status === 'OK') {
      console.log(`[sms] sent to ${phoneNorm} via SMS.ru`);
      return { ok: true, status: 'sent' };
    }
    const firstSms = data.sms ? Object.values(data.sms)[0] : null;
    const errMsg = firstSms?.status_text || `status_code=${data.status_code}`;
    console.warn(`[sms] failed for ${phoneNorm}: ${errMsg}`);
    return { ok: false, error: errMsg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sms] network error for ${phoneNorm}: ${msg}`);
    return { ok: false, error: 'SMS-шлюз недоступен' };
  }
}
