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
  phone: string;
  name: string;
  storeId: number;
}): Promise<RegisterEmployeeResult | { error: string; status: number }> {
  const phoneNorm = normalizePhone(input.phone);
  if (phoneNorm.length !== 11) return { error: 'Неверный формат телефона. Введи 11 цифр (например 89991234567)', status: 400 };

  const name = (input.name ?? '').trim();
  if (!name || name.length > 100) return { error: 'Имя должно быть от 1 до 100 символов', status: 400 };

  if (!Number.isInteger(input.storeId) || input.storeId <= 0) return { error: 'Выбери точку', status: 400 };

  // Проверяем что точка существует и активна
  const { rows: storeRows } = await pool.query<{ id: number }>(
    `SELECT id FROM stores WHERE id = $1 AND is_active = true`,
    [input.storeId]
  );
  if (!storeRows[0]) return { error: 'Точка не найдена или неактивна', status: 404 };

  // Проверяем дубликат
  const { rows: existing } = await pool.query<{ id: number }>(
    `SELECT id FROM employees WHERE phone_normalized = $1`,
    [phoneNorm]
  );
  if (existing[0]) return { error: 'Этот номер уже зарегистрирован. Войди как обычно через получение кода.', status: 409 };

  // Сохраняем телефон в +7-формате для совместимости с тем как его собирает бот
  const phoneFormatted = '+' + phoneNorm;

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO employees (name, phone, phone_normalized, store_id, joined_at, role, is_active)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, 'employee', true)
     RETURNING id`,
    [name, phoneFormatted, phoneNorm, input.storeId]
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
  telegramChatId: string | null; // null если нет привязки — отправляем по SMS
  phone: string | null;
  pin: string;            // raw PIN — caller сам отправит через бота / SMS
}

/**
 * Запрос PIN. Возвращает raw PIN — caller (route) должен сам отправить его
 * через бота. PIN-хеш сохраняется в БД.
 */
export async function requestPin(phone: string): Promise<PinRequestResult | { error: string; status: number }> {
  const phoneNorm = normalizePhone(phone);
  if (phoneNorm.length < 10) return { error: 'Неверный формат телефона', status: 400 };

  const { rows } = await pool.query<{ id: number; telegramId: string | null; phone: string | null }>(
    `SELECT id, telegram_id::text AS "telegramId", phone
     FROM employees
     WHERE phone_normalized = $1 AND is_active = true
     ORDER BY id LIMIT 1`,
    [phoneNorm]
  );
  const employee = rows[0];
  if (!employee) return { error: 'Сотрудник с таким номером не найден', status: 404 };

  // Канал доставки: Telegram (если привязан) ИЛИ SMS (через SMSRU_API_KEY).
  // Если ни одного канала нет — ошибка с понятной подсказкой.
  const hasTelegram = !!employee.telegramId;
  const hasSmsConfig = !!process.env.SMSRU_API_KEY;
  if (!hasTelegram && !hasSmsConfig) {
    return {
      error: 'Сначала запусти бота @Mariaprod_bot и нажми /start — нужно связать номер с Telegram, чтобы прислать код. Либо настройте SMS-шлюз.',
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
    phone: employee.phone, // для SMS-канала — берём оригинальный (с +)
    pin,
  };
}

export interface VerifyPinResult {
  employeeId: number;
  token: string;
  expiresAt: Date;
}

/**
 * Проверяет PIN и выдаёт JWT. PIN помечается использованным.
 */
export async function verifyPinAndIssueToken(
  phone: string,
  pin: string
): Promise<VerifyPinResult | { error: string; status: number }> {
  const phoneNorm = normalizePhone(phone);
  if (phoneNorm.length < 10) return { error: 'Неверный формат телефона', status: 400 };
  if (!/^\d{6}$/.test(pin)) return { error: 'PIN должен быть 6 цифр', status: 400 };

  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM employees
     WHERE phone_normalized = $1 AND is_active = true
     ORDER BY id LIMIT 1`,
    [phoneNorm]
  );
  const employee = rows[0];
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

  if (!verifyPin(pin, pinRows[0].pinHash)) {
    return { error: 'Неверный код', status: 401 };
  }

  // Помечаем PIN использованным + чистим старые истёкшие (housekeeping)
  await pool.query(`UPDATE auth_pins SET used_at = NOW() WHERE id = $1`, [pinRows[0].id]);
  await pool.query(`DELETE FROM auth_pins WHERE expires_at < NOW() - INTERVAL '7 days'`);

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const token = signEmployeeToken(employee.id, expiresAt.getTime());
  return { employeeId: employee.id, token, expiresAt };
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
