import { pool } from '../../db/pool';
import { vpnConfigured, listPanelUsers } from '../../services/vpn.service';

/**
 * «Ай-ай-ай»-страж: кто-то ввёл VPN-код сотрудника на втором устройстве
 * (панель фиксирует codes.conflict_at при code_bound_other_device) —
 * сотруднику прилетает шутливое, но однозначное сообщение в TG-бота:
 * код работает только на одном устройстве, восстановление — через администратора.
 *
 * Дедуп по vpn_conflict_notified: одно уведомление на каждый НОВЫЙ conflict_at
 * (панель обновляет метку при каждой новой попытке). Юзеры панели без маппинга
 * на сотрудника с telegram_id молча пропускаются (внешние/несвязанные) — но
 * conflict_at запоминаем, чтобы при поздней привязке не прилетело старое.
 */
const AYAYAY_HTML =
  '🙈 <b>Ай-ай-ай!</b> Кто-то только что попытался активировать <b>твой</b> VPN-код на другом устройстве.\n\n' +
  'Так делать нельзя 😄 Код — личный и работает только на <b>одном</b> устройстве, как зубная щётка.\n\n' +
  '👀 Система такие попытки видит и помечает, а за передачу кода доступ отзывается.\n\n' +
  '🔑 Если это ты сам(а) — например, новый телефон или компьютер — или хочешь восстановить доступ, просто обратись к администратору: выдаст новый код, это минута.';

export async function vpnConflictNotify(
  sendMessage: (telegramId: string, html: string) => Promise<void>
): Promise<void> {
  if (!vpnConfigured()) return;
  const users = await listPanelUsers();
  const withConflict = users.filter(u => u.codeConflict && u.codeConflict.at > 0);
  if (!withConflict.length) return;

  const [notified, links] = await Promise.all([
    pool.query<{ vpnName: string; notifiedConflictAt: string }>(
      'SELECT vpn_name AS "vpnName", notified_conflict_at AS "notifiedConflictAt" FROM vpn_conflict_notified'),
    pool.query<{ vpnName: string; telegramId: string | null }>(
      `SELECT ev.vpn_name AS "vpnName", e.telegram_id::text AS "telegramId"
       FROM employee_vpn ev JOIN employees e ON e.id = ev.employee_id
       WHERE e.fired_at IS NULL`),
  ]);
  const seen = new Map(notified.rows.map(r => [r.vpnName, Number(r.notifiedConflictAt)]));
  const tgByVpn = new Map(links.rows.map(r => [r.vpnName, r.telegramId]));

  for (const u of withConflict) {
    const at = u.codeConflict!.at;
    if ((seen.get(u.name) ?? 0) >= at) continue; // уже писали про эту попытку
    const telegramId = tgByVpn.get(u.name);
    if (telegramId) {
      await sendMessage(telegramId, AYAYAY_HTML);
      console.log(`[vpnConflictNotify] ай-ай-ай отправлен: ${u.name} (conflict_at=${at})`);
    }
    // запоминаем в любом случае: несвязанным/без TG старые конфликты не досылаем
    await pool.query(
      `INSERT INTO vpn_conflict_notified (vpn_name, notified_conflict_at) VALUES ($1, $2)
       ON CONFLICT (vpn_name) DO UPDATE SET notified_conflict_at = EXCLUDED.notified_conflict_at`,
      [u.name, at]
    );
  }
}
