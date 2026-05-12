// Email через Gmail SMTP (nodemailer).
// Без сторонних сервисов, без подтверждения домена — отправка от вашего gmail.
//
// Активация через env переменные:
//   GMAIL_USER         — gmail-адрес отправителя (например reklama.maria.irk@gmail.com)
//   GMAIL_APP_PASSWORD — application password Gmail (НЕ обычный пароль, а специальный)
//
// Лимит: 500 писем/день для обычного аккаунта, 2000 для Google Workspace.
//
// Без переменных sendEmail() возвращает no-op (логирует, но не падает).

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface EmailResult {
  ok: boolean;
  error?: string;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

let _transporter: Transporter | null = null;
function getTransporter(): Transporter | null {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  if (_transporter) return _transporter;

  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return _transporter;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string
): Promise<EmailResult> {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[email] no GMAIL_USER/GMAIL_APP_PASSWORD — would send to ${to}: "${subject}"`);
    return { ok: false, error: 'Email-сервис не настроен' };
  }
  if (!isValidEmail(to)) {
    return { ok: false, error: 'Неверный email' };
  }

  try {
    const info = await transporter.sendMail({
      from: `Maria Crew <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`[email] sent to ${to} via Gmail SMTP (id=${info.messageId})`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[email] failed for ${to}: ${msg}`);
    return { ok: false, error: msg };
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
