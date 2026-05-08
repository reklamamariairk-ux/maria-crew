// Email-уведомления через Resend (https://resend.com).
// Бесплатно 3000 писем/месяц + 100 в день, без необходимости подтверждать домен
// для transactional. Активируется через env RESEND_API_KEY. Без ключа — no-op.
//
// Доменом-отправителем по умолчанию используется onboarding@resend.dev (тестовый
// домен Resend, разрешён для тестов). Когда захотите свой — пропишите
// RESEND_FROM = "Maria Crew <noreply@yourdomain.ru>" + добавьте DNS записи
// (SPF/DKIM) в Resend dashboard.

export interface EmailResult {
  ok: boolean;
  error?: string;
}

export function isValidEmail(email: string): boolean {
  // Простая валидация — подробная не нужна, всё равно сервер бекенда отвергнет невалидное
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string
): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[email] no RESEND_API_KEY — would send to ${to}: "${subject}"`);
    return { ok: false, error: 'Email-сервис не настроен' };
  }
  if (!isValidEmail(to)) {
    return { ok: false, error: 'Неверный email' };
  }

  const from = process.env.RESEND_FROM || 'Maria Crew <onboarding@resend.dev>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json() as { id?: string; message?: string; name?: string };
    if (!res.ok) {
      const err = data.message || data.name || `HTTP ${res.status}`;
      console.warn(`[email] failed for ${to}: ${err}`);
      return { ok: false, error: err };
    }
    console.log(`[email] sent to ${to} via Resend (id=${data.id})`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[email] network error for ${to}: ${msg}`);
    return { ok: false, error: 'Email-сервис недоступен' };
  }
}

export function buildLoginPinEmail(pin: string): { subject: string; html: string } {
  const subject = `Maria Crew · Код входа ${pin}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
      <div style="background:#dc1e3c;color:#fff;padding:28px;border-radius:16px;text-align:center;margin-bottom:24px">
        <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;opacity:0.9">Maria Crew</div>
        <div style="font-size:14px;margin-top:6px;opacity:0.85">Код для входа в приложение</div>
        <div style="font-size:42px;font-weight:900;letter-spacing:10px;margin-top:18px;font-family:Menlo,Consolas,monospace">${pin}</div>
      </div>
      <p style="color:#666;font-size:13px;line-height:1.5;margin:0">
        Действует <strong>10 минут</strong>. Никому не сообщайте этот код.<br>
        Если вы не запрашивали — просто проигнорируйте письмо.
      </p>
    </div>
  `;
  return { subject, html };
}
