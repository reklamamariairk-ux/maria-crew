// Авторизация сотрудников для мобильного приложения и stand-alone веб-клиента.
// Поток: phone → PIN в Telegram → JWT (30 дней).
//
// Дизайн:
// - Никаких паролей — нечего «забыть» и нечего утечь.
// - PIN — 6 цифр, живёт 10 минут, использован один раз.
// - PIN отправляется в Telegram-чат бота (employee.telegram_id уже привязан).
// - Если у сотрудника нет привязанного telegram_id — пускай сначала запустит бот.
// - Rate limit: один PIN можно запросить не чаще раза в 60 секунд на одного сотрудника.

import { scryptSync, randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { pool } from '../db/pool';
import { effectiveAdminSecret } from '../api/middleware/secret';

const PIN_TTL_MS = 10 * 60 * 1000;             // 10 минут на ввод
const PIN_REQUEST_COOLDOWN_MS = 60 * 1000;     // 1 минута между запросами
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней — типично для мобильных приложений

// ── Регистрация нового сотрудника из мобильного приложения ────────────────

export interface RegisterEmployeeResult {
  employeeId: number;
  token: string;
  expiresAt: Date;
}

/**
 * Регистрация без Telegram: создаёт нового активного сотрудника по
 * phone+name+storeId и сразу выдаёт JWT. Используется когда юзер открыл
 * приложение, ввёл телефон, и его нет в БД.
 *
 * Защиты:
 * - phone должен нормализоваться к 11 цифрам (российский номер)
 * - сотрудник с таким phone_normalized уже существует → 409
 * - storeId должен соответствовать активной точке
 * - длина name 1..100 символов
 *
 * НЕ верифицируем владение телефоном — это внутренний инструмент компании,
 * админ может деактивировать фейка в админке. SMS-верификация — TODO,
 * требует подключения шлюза (стоит денег).
 */
export async function registerNewEmployee(input: {
  phone?: string | null;
  email?: string | null;
  name: string;
  storeId: number;
}): Promise<RegisterEmployeeResult | { error: string; status: number }> {
  const name = (input.name ?? '').trim();
  if (!name || name.length > 100) return { error: 'Имя должно быть от 1 до 100 символов', status: 400 };
  if (!Number.isInteger(input.storeId) || input.storeId <= 0) return { error: 'Выбери точку', status: 400 };

  const hasPhone = !!(input.phone && input.phone.trim());
  const hasEmail = !!(input.email && input.email.trim());
  if (!hasPhone && !hasEmail) {
    return { error: 'Нужен телефон или email', status: 400 };
  }

  // Нормализация
  let phoneNorm: string | null = null;
  let phoneFormatted: string | null = null;
  if (hasPhone) {
    phoneNorm = normalizePhone(input.phone!);
    if (phoneNorm.length !== 11) return { error: 'Неверный формат телефона. Введи 11 цифр (например 89991234567)', status: 400 };
    phoneFormatted = '+' + phoneNorm;
  }
  let emailNorm: string | null = null;
  if (hasEmail) {
    emailNorm = input.email!.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) return { error: 'Неверный формат email', status: 400 };
  }

  // Проверяем что точка существует и активна
  const { rows: storeRows } = await pool.query<{ id: number }>(
    `SELECT id FROM stores WHERE id = $1 AND is_active = true`,
    [input.storeId]
  );
  if (!storeRows[0]) return { error: 'Точка не найдена или неактивна', status: 404 };

  // Дубликаты
  if (phoneNorm) {
    const { rows: dup } = await pool.query<{ id: number }>(
      `SELECT id FROM employees WHERE phone_normalized = $1`, [phoneNorm]
    );
    if (dup[0]) return { error: 'Этот номер уже зарегистрирован. Войди через получение кода.', status: 409 };
  }
  if (emailNorm) {
    const { rows: dup } = await pool.query<{ id: number }>(
      `SELECT id FROM employees WHERE LOWER(email) = $1`, [emailNorm]
    );
    if (dup[0]) return { error: 'Этот email уже зарегистрирован', status: 409 };
  }

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO employees (name, phone, phone_normalized, email, store_id, joined_at, role, is_active)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 'employee', true)
     RETURNING id`,
    [name, phoneFormatted, phoneNorm, emailNorm, input.storeId]
  );
  const employeeId = rows[0].id;

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const token = signEmployeeToken(employeeId, expiresAt.getTime());
  return { employeeId, token, expiresAt };
}

// ── PIN ─────────────────────────────────────────────────────────────────────

function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const computed = scryptSync(pin, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(computed, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Нормализует телефон: оставляет только цифры. Для российских номеров
 * приводит «8XXXXXXXXXX» к «7XXXXXXXXXX» — это один и тот же номер
 * в разных нотациях, и пользователь может ввести как угодно.
 */
export function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D+/g, '');
  // Российский трюк: 8 в начале 11-значного номера = +7
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = '7' + digits.slice(1);
  }
  return digits;
}

export interface PinRequestResult {
  ok: true;
  ttlSeconds: number;
  telegramChatId: string | null; // null если нет привязки → отправляем по email
  email: string | null;
  pin: string;            // raw PIN — caller сам отправит через бота / email
}

/**
 * Запрос PIN — по телефону ИЛИ по email. Возвращает raw PIN; caller сам
 * отправляет через нужный канал.
 */
export async function requestPin(input: { phone?: string; email?: string }): Promise<PinRequestResult | { error: string; status: number }> {
  let employee: { id: number; telegramId: string | null; phone: string | null; email: string | null } | undefined;

  if (input.email) {
    const emailNorm = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return { error: 'Неверный формат email', status: 400 };
    }
    const { rows } = await pool.query<{ id: number; telegramId: string | null; phone: string | null; email: string | null }>(
      `SELECT id, telegram_id::text AS "telegramId", phone, email
       FROM employees
       WHERE LOWER(email) = $1 AND is_active = true
       ORDER BY id LIMIT 1`,
      [emailNorm]
    );
    employee = rows[0];
    if (!employee) return { error: 'Сотрудник с таким email не найден', status: 404 };
  } else if (input.phone) {
    const phoneNorm = normalizePhone(input.phone);
    if (phoneNorm.length < 10) return { error: 'Неверный формат телефона', status: 400 };
    const { rows } = await pool.query<{ id: number; telegramId: string | null; phone: string | null; email: string | null }>(
      `SELECT id, telegram_id::text AS "telegramId", phone, email
       FROM employees
       WHERE phone_normalized = $1 AND is_active = true
       ORDER BY id LIMIT 1`,
      [phoneNorm]
    );
    employee = rows[0];
    if (!employee) return { error: 'Сотрудник с таким номером не найден', status: 404 };
  } else {
    return { error: 'Нужен phone или email', status: 400 };
  }

  // Канал доставки: Telegram (если привязан) ИЛИ Email (если задан и Resend настроен)
  const hasTelegram = !!employee.telegramId;
  const hasEmail = !!employee.email && !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
  if (!hasTelegram && !hasEmail) {
    return {
      error: 'Не задан ни Telegram, ни email. Запусти бота @Mariaprod_bot и нажми /start, либо добавь email в профиле.',
      status: 409,
    };
  }

  // Cooldown: проверяем, что последний PIN запрошен не позже COOLDOWN
  const { rows: recent } = await pool.query<{ createdAt: Date }>(
    `SELECT created_at AS "createdAt" FROM auth_pins
     WHERE employee_id = $1
     ORDER BY id DESC LIMIT 1`,
    [employee.id]
  );
  if (recent[0]) {
    const ageMs = Date.now() - new Date(recent[0].createdAt).getTime();
    if (ageMs < PIN_REQUEST_COOLDOWN_MS) {
      const wait = Math.ceil((PIN_REQUEST_COOLDOWN_MS - ageMs) / 1000);
      return { error: `Слишком часто. Подожди ${wait} секунд`, status: 429 };
    }
  }

  // Генерируем 6-значный PIN. Crypto-random чтобы не угадать.
  const pin = String(Math.floor(randomBytes(4).readUInt32BE() % 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + PIN_TTL_MS);

  await pool.query(
    `INSERT INTO auth_pins (employee_id, pin_hash, expires_at) VALUES ($1, $2, $3)`,
    [employee.id, hashPin(pin), expiresAt]
  );

  return {
    ok: true,
    ttlSeconds: Math.floor(PIN_TTL_MS / 1000),
    telegramChatId: employee.telegramId,
    email: employee.email,
    pin,
  };
}

export interface VerifyPinResult {
  employeeId: number;
  token: string;
  expiresAt: Date;
}

/**
 * Проверяет PIN и выдаёт JWT. Принимает phone ИЛИ email.
 */
export async function verifyPinAndIssueToken(
  input: { phone?: string; email?: string; pin: string }
): Promise<VerifyPinResult | { error: string; status: number }> {
  if (!/^\d{6}$/.test(input.pin)) return { error: 'PIN должен быть 6 цифр', status: 400 };

  let employee: { id: number } | undefined;
  if (input.email) {
    const emailNorm = input.email.trim().toLowerCase();
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM employees WHERE LOWER(email) = $1 AND is_active = true ORDER BY id LIMIT 1`,
      [emailNorm]
    );
    employee = rows[0];
  } else if (input.phone) {
    const phoneNorm = normalizePhone(input.phone);
    if (phoneNorm.length < 10) return { error: 'Неверный формат телефона', status: 400 };
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM employees WHERE phone_normalized = $1 AND is_active = true ORDER BY id LIMIT 1`,
      [phoneNorm]
    );
    employee = rows[0];
  } else {
    return { error: 'Нужен phone или email', status: 400 };
  }
  if (!employee) return { error: 'Сотрудник не найден', status: 404 };

  // Берём последний неиспользованный, не истёкший PIN. Берём ОДИН — повторные запросы
  // PIN'а инвалидируют предыдущие (сравнение только с последним).
  const { rows: pinRows } = await pool.query<{ id: number; pinHash: string }>(
    `SELECT id, pin_hash AS "pinHash" FROM auth_pins
     WHERE employee_id = $1 AND used_at IS NULL AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    [employee.id]
  );
  if (!pinRows[0]) return { error: 'Код не найден или истёк. Запроси новый.', status: 401 };

  if (!verifyPin(input.pin, pinRows[0].pinHash)) {
    return { error: 'Неверный код', status: 401 };
  }

  // Помечаем PIN использованным + чистим старые истёкшие (housekeeping)
  await pool.query(`UPDATE auth_pins SET used_at = NOW() WHERE id = $1`, [pinRows[0].id]);
  await pool.query(`DELETE FROM auth_pins WHERE expires_at < NOW() - INTERVAL '7 days'`);

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const token = signEmployeeToken(employee.id, expiresAt.getTime());
  return { employeeId: employee.id, token, expiresAt };
}

/** Простой логин по телефону БЕЗ подтверждения кодом — для внутреннего
 *  использования. Находит активного сотрудника по нормализованному phone
 *  и сразу выдаёт JWT.
 *
 *  ВНИМАНИЕ: безопасность ослаблена — любой кто знает телефон коллеги
 *  сможет войти от его имени. Использовать только в доверенной среде
 *  (внутренние сотрудники Маши). */
export async function loginByPhoneNoPin(phone: string): Promise<
  | { employeeId: number; token: string; expiresAt: Date }
  | { error: string; status: number }
> {
  const phoneNorm = normalizePhone(phone);
  if (!phoneNorm) return { error: 'Неверный формат телефона', status: 400 };

  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM employees
     WHERE phone_normalized = $1 AND is_active = true
     LIMIT 1`,
    [phoneNorm]
  );
  if (!rows[0]) return { error: 'Сотрудник с таким телефоном не найден', status: 404 };

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const token = signEmployeeToken(rows[0].id, expiresAt.getTime());
  return { employeeId: rows[0].id, token, expiresAt };
}

// ── JWT-подобные токены (HMAC-подписанный JSON) ────────────────────────────

interface EmployeeTokenPayload {
  uid: number;
  scope: 'employee'; // отличие от админских токенов
  exp: number;       // ms
}

export function signEmployeeToken(employeeId: number, expMs: number): string {
  const payload: EmployeeTokenPayload = { uid: employeeId, scope: 'employee', exp: expMs };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', effectiveAdminSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyEmployeeToken(token: string): EmployeeTokenPayload | null {
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = createHmac('sha256', effectiveAdminSecret).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as EmployeeTokenPayload;
    if (payload.scope !== 'employee') return null;
    if (!Number.isInteger(payload.uid) || payload.uid <= 0) return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
