// Push-уведомления для мобильного приложения через Firebase Cloud Messaging.
// FCM умеет в Android и iOS (через APNs proxy) — один SDK, один сервер-ключ.
//
// Поведение:
// - Если env FIREBASE_SERVICE_ACCOUNT_JSON не задан — отправка no-op,
//   логируем в консоль. Это позволяет backend жить без Firebase до того
//   как админ создаст project и пропишет ключ.
// - Когда ключ есть — firebase-admin инициализируется лениво (на первый
//   вызов sendPushToEmployee), сразу шлёт через sendEachForMulticast,
//   и подчищает невалидные токены в БД.

import { pool } from '../db/pool';
import { initializeApp, cert, App, getApps } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';

export interface DeviceToken {
  id: number;
  token: string;
  platform: 'ios' | 'android' | 'web';
}

export async function registerDeviceToken(
  employeeId: number,
  token: string,
  platform: 'ios' | 'android' | 'web',
  meta?: { appVersion?: string; deviceModel?: string }
): Promise<void> {
  if (!token || token.length < 10) throw new Error('Невалидный токен устройства');

  // ON CONFLICT: один и тот же FCM-токен может «переехать» от одного сотрудника
  // к другому (редко, но бывает — например, при переустановке приложения и логине
  // под другим аккаунтом). Перезаписываем владельца.
  await pool.query(
    `INSERT INTO device_tokens (employee_id, token, platform, app_version, device_model)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token) DO UPDATE SET
       employee_id = EXCLUDED.employee_id,
       app_version = EXCLUDED.app_version,
       device_model = EXCLUDED.device_model,
       last_seen_at = NOW()`,
    [employeeId, token, platform, meta?.appVersion ?? null, meta?.deviceModel ?? null]
  );
}

// Скоуп по владельцу (employeeId) — чтобы нельзя было отписать чужой токен (IDOR).
export async function unregisterDeviceToken(token: string, employeeId: number): Promise<void> {
  await pool.query(`DELETE FROM device_tokens WHERE token = $1 AND employee_id = $2`, [token, employeeId]);
}

export interface PushPayload {
  title: string;
  body: string;
  /** Дополнительные key-value, доступные в notification handler приложения */
  data?: Record<string, string>;
}

// ── Firebase Admin lazy init ────────────────────────────────────────────────
// Инициализируем один раз при первой отправке. Парсим JSON-ключ из env.
// Возвращаем null, если ключ не задан или некорректен — тогда отправка no-op.
let firebaseApp: App | null = null;
let firebaseInitFailed = false;

function getFirebaseMessaging(): Messaging | null {
  if (firebaseInitFailed) return null;
  if (firebaseApp) return getMessaging(firebaseApp);

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) return null;

  try {
    // Если firebase-admin уже инициализирован где-то (на CI, в тестах) — переиспользуем.
    const existing = getApps()[0];
    if (existing) {
      firebaseApp = existing;
      return getMessaging(firebaseApp);
    }

    const serviceAccount = JSON.parse(json);
    firebaseApp = initializeApp({ credential: cert(serviceAccount) });
    console.log('[push] Firebase initialized');
    return getMessaging(firebaseApp);
  } catch (err) {
    firebaseInitFailed = true;
    console.error('[push] Firebase init failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Отправляет push-уведомление на все зарегистрированные устройства сотрудника.
 * Возвращает количество устройств, на которые удалось отправить.
 *
 * Если FCM не настроен — возвращает 0 и логирует попытку (no-op).
 * Это позволяет вызывать sendPushToEmployee() из любых notify-функций
 * безопасно, не дожидаясь настройки Firebase.
 */
export async function sendPushToEmployee(
  employeeId: number,
  payload: PushPayload
): Promise<number> {
  const { rows } = await pool.query<DeviceToken>(
    `SELECT id, token, platform FROM device_tokens WHERE employee_id = $1`,
    [employeeId]
  );
  if (rows.length === 0) return 0;

  const messaging = getFirebaseMessaging();
  if (!messaging) {
    console.log(`[push] would send to employee=${employeeId} (${rows.length} devices): "${payload.title}" — FCM не настроен`);
    return 0;
  }

  try {
    const result = await messaging.sendEachForMulticast({
      tokens: rows.map(r => r.token),
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
    });

    // Чистим невалидные токены, чтобы база не разрослась мёртвыми записями.
    // FCM возвращает specific error codes для удалённых / неактивных токенов.
    const deadCodes = new Set([
      'messaging/registration-token-not-registered',
      'messaging/invalid-registration-token',
      'messaging/invalid-argument',
    ]);
    const toDelete: string[] = [];
    for (let i = 0; i < result.responses.length; i++) {
      const r = result.responses[i];
      if (!r.success && r.error && deadCodes.has(r.error.code)) {
        toDelete.push(rows[i].token);
      }
    }
    if (toDelete.length > 0) {
      await pool.query(`DELETE FROM device_tokens WHERE token = ANY($1::text[])`, [toDelete]);
      console.log(`[push] cleaned ${toDelete.length} dead tokens`);
    }

    return result.successCount;
  } catch (err) {
    console.error('[push] sendEachForMulticast failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}
