/**
 * Увольнение/возврат сотрудника.
 *
 * Увольнение: fired_at=NOW(), is_active=false (вход в Mini App/APK закрывается существующими
 * is_active-фильтрами auth), VPN отзывается через панель (ПК + телефон) по маппингу employee_vpn.
 * Ошибки VPN-панели НЕ блокируют увольнение — панель может быть недоступна; результат
 * ('ok'|'unavailable'|'no_vpn') отдаём наверх, админ видит и может повторить из карточки.
 *
 * Возврат: fired_at=NULL, is_active=true, ключи реактивируются (revoke в панели закрывает порт,
 * но сохраняет пароль — у сотрудника «всё появляется» без перевыдачи и переустановки).
 *
 * Авто-увольнение: имя с 1С-пометкой «не работает» (см. FIRED_NAME_RE) при создании/переименовании.
 * Обратное переименование автоматически НЕ возвращает — возврат только осознанной кнопкой.
 */
import { pool } from '../db/pool';
import { logAudit } from './audit.service';
import { vpnConfigured, panelUserAction } from './vpn.service';

/** 1С-пометка уволенного в имени: «Иванова А.А. (не работает)» и вариации. */
export const FIRED_NAME_RE = /не\s*работает/i;

export type FireVpnResult = 'ok' | 'unavailable' | 'no_vpn';

export interface FireResult {
  id: number;
  name: string;
  firedAt: string | null;
  vpn: FireVpnResult;
}

async function vpnNameOf(employeeId: number): Promise<string | null> {
  const r = await pool.query<{ vpnName: string }>(
    'SELECT vpn_name AS "vpnName" FROM employee_vpn WHERE employee_id = $1',
    [employeeId]
  );
  return r.rows[0]?.vpnName ?? null;
}

/** Отозвать/вернуть оба ключа (ПК + телефон) best-effort. */
export async function applyVpnFired(employeeId: number, fired: boolean): Promise<FireVpnResult> {
  if (!vpnConfigured()) return 'no_vpn';
  const name = await vpnNameOf(employeeId);
  if (!name) return 'no_vpn';
  let pcOk = false;
  try {
    await panelUserAction(name, fired ? 'revoke' : 'reactivate');
    pcOk = true;
  } catch (err) {
    console.error(`[fire] vpn ${fired ? 'revoke' : 'reactivate'} failed for "${name}":`,
      err instanceof Error ? err.message : err);
  }
  try {
    await panelUserAction(name, fired ? 'phone/revoke' : 'phone/reactivate');
  } catch {
    // телефонного ключа может не быть / уже в нужном статусе — не критично
  }
  return pcOk ? 'ok' : 'unavailable';
}

export async function fireEmployee(
  id: number,
  source: 'manual' | 'auto_1c',
  performedBy?: string
): Promise<FireResult | null> {
  const r = await pool.query<{ id: number; name: string; firedAt: string | null }>(
    `UPDATE employees SET fired_at = COALESCE(fired_at, NOW()), is_active = false
     WHERE id = $1
     RETURNING id, name, fired_at AS "firedAt"`,
    [id]
  );
  if (!r.rows[0]) return null;
  const vpn = await applyVpnFired(id, true);
  logAudit('employee_fire', { employeeId: id, name: r.rows[0].name, source, vpn }, performedBy).catch(() => {});
  return { ...r.rows[0], vpn };
}

export async function restoreEmployee(id: number, performedBy?: string): Promise<FireResult | null> {
  const r = await pool.query<{ id: number; name: string; firedAt: string | null }>(
    `UPDATE employees SET fired_at = NULL, is_active = true
     WHERE id = $1
     RETURNING id, name, fired_at AS "firedAt"`,
    [id]
  );
  if (!r.rows[0]) return null;
  const vpn = await applyVpnFired(id, false);
  logAudit('employee_restore', { employeeId: id, name: r.rows[0].name, vpn }, performedBy).catch(() => {});
  return { ...r.rows[0], vpn };
}
