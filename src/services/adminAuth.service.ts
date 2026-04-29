import { scryptSync, randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { pool } from '../db/pool';
import { effectiveAdminSecret } from '../api/middleware/secret';

export type AdminRole = 'superadmin' | 'editor' | 'coin_admin';
const VALID_ROLES: AdminRole[] = ['superadmin', 'editor', 'coin_admin'];

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

// ── Пароли (scrypt) ─────────────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const computed = scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(computed, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Подписанные токены (JSON.HMAC) ──────────────────────────────────────────

interface TokenPayload { uid: number; role: AdminRole; exp: number; }

export function signToken(uid: number, role: AdminRole): string {
  const payload: TokenPayload = { uid, role, exp: Date.now() + SESSION_DURATION_MS };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', effectiveAdminSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const idx = token.indexOf('.');
  if (idx < 1) return null;
  const data = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  const expected = createHmac('sha256', effectiveAdminSecret).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as TokenPayload;
    if (!payload.uid || !VALID_ROLES.includes(payload.role)) return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Бутстрап начального суперадмина ─────────────────────────────────────────
// Username: 'admin', пароль = effectiveAdminSecret (из env ADMIN_SECRET).

export async function ensureBootstrapSuperadmin(): Promise<void> {
  try {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM admin_users WHERE role = 'superadmin' AND is_active = true`
    );
    if (parseInt(rows[0].count, 10) > 0) return;

    const hash = hashPassword(effectiveAdminSecret);
    await pool.query(
      `INSERT INTO admin_users (username, password_hash, role)
       VALUES ('admin', $1, 'superadmin')
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         role = 'superadmin',
         is_active = true`,
      [hash]
    );
    console.log('[admin] Bootstrap superadmin: username=admin, password=ADMIN_SECRET');
  } catch (err) {
    console.error('[admin] ensureBootstrapSuperadmin failed:', err instanceof Error ? err.message : err);
  }
}

// ── Утилиты для работы с пользователями ─────────────────────────────────────

export async function authenticate(username: string, password: string): Promise<{ uid: number; role: AdminRole } | null> {
  const { rows } = await pool.query<{ id: number; password_hash: string; role: AdminRole }>(
    `SELECT id, password_hash, role FROM admin_users WHERE username = $1 AND is_active = true`,
    [username]
  );
  if (!rows[0]) return null;
  if (!verifyPassword(password, rows[0].password_hash)) return null;
  await pool.query(`UPDATE admin_users SET last_login_at = NOW() WHERE id = $1`, [rows[0].id]);
  return { uid: rows[0].id, role: rows[0].role };
}
