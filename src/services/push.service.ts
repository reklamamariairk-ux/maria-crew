// Push-уведомления для мобильного приложения через Firebase Cloud Messaging.
// FCM умеет в Android и iOS (через APNs proxy) — один SDK, один сервер-ключ.
//
// Состояние:
// - Endpoints для регистрации/удаления токенов работают.
// - sendPush() ниже — заглушка-логгер: пока не настроен Firebase service account,
//   возвращаем всегда true и пишем в консоль. Когда придёт время — раскомментировать
//   firebase-admin интеграцию (~10 строк, см. TODO в коде).
//
// Why: чтобы не блокировать разработку фронта мобильного приложения. Все
// nofityXxx-функции уже могут вызывать sendPushToEmployee(), а реальная отправка
// включится позже добавлением FIREBASE_SERVICE_ACCOUNT_JSON в env.

import { pool } from '../db/pool';

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

export async function unregisterDeviceToken(token: string): Promise<void> {
  await pool.query(`DELETE FROM device_tokens WHERE token = $1`, [token]);
}

export interface PushPayload {
  title: string;
  body: string;
  /** Дополнительные key-value, доступные в notification handler приложения */
  data?: Record<string, string>;
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

  const fcmConfigured = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!fcmConfigured) {
    console.log(`[push] would send to employee=${employeeId} (${rows.length} devices): "${payload.title}" — FCM не настроен`);
    return 0;
  }

  // TODO: реальная отправка через firebase-admin. Раскомментировать когда добавим зависимость:
  //
  //   import { getMessaging } from 'firebase-admin/messaging';
  //   import { initializeApp, cert } from 'firebase-admin/app';
  //   const app = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!)) });
  //   const messaging = getMessaging(app);
  //   const result = await messaging.sendEachForMulticast({
  //     tokens: rows.map(r => r.token),
  //     notification: { title: payload.title, body: payload.body },
  //     data: payload.data,
  //   });
  //   // Чистим невалидные токены из БД
  //   for (let i = 0; i < result.responses.length; i++) {
  //     const r = result.responses[i];
  //     if (!r.success && r.error?.code?.includes('registration-token-not-registered')) {
  //       await pool.query(`DELETE FROM device_tokens WHERE token = $1`, [rows[i].token]);
  //     }
  //   }
  //   return result.successCount;

  return 0;
}
