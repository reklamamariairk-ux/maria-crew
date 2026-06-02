import { pool } from '../../db/pool';

/**
 * Ежедневно в 10:00 Иркутска: отправляет каждому менеджеру/админу сводку
 * непогашенных заявок старше 24 часов на их точке.
 * Управляющие сами видят свои заявки в админке, но напомнить полезно.
 */
export async function digestPendingExchanges(
  sendMessage: (telegramId: string, html: string) => Promise<void>
): Promise<void> {
  // Заявки в статусе pending старше 24 часов — кому какая точка
  const { rows: pendingByStore } = await pool.query<{
    storeId: number; storeName: string; pendingCount: number;
  }>(
    `SELECT e.store_id AS "storeId", s.name AS "storeName", COUNT(*)::int AS "pendingCount"
     FROM store_exchanges se
     JOIN employees e ON e.id = se.employee_id
     JOIN stores s ON s.id = e.store_id
     WHERE se.status = 'pending'
       AND se.created_at < NOW() - INTERVAL '24 hours'
     GROUP BY e.store_id, s.name`
  );

  if (pendingByStore.length === 0) return;

  // Менеджеры/админы каждой точки + все суперадмины
  const { rows: recipients } = await pool.query<{
    telegramId: string; storeId: number | null; role: string;
  }>(
    `SELECT e.telegram_id::text AS "telegramId", e.store_id AS "storeId", e.role
     FROM employees e
     WHERE e.role IN ('manager', 'admin')
       AND e.is_active = true
       AND e.telegram_id IS NOT NULL`
  );

  // Группируем заявки по storeId
  const pendingMap = new Map(pendingByStore.map(p => [p.storeId, p]));

  // Имена точек идут в HTML-сообщение — экранируем, иначе «<»/«&» дают Telegram 400
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let sent = 0;
  for (const r of recipients) {
    let text = '';
    if (r.role === 'admin') {
      // Админ видит все точки
      const lines = pendingByStore.map(p => `• <b>${esc(p.storeName)}</b>: ${p.pendingCount} ${plur(p.pendingCount)}`);
      text = `📋 <b>Незакрытые заявки старше 24 часов</b>\n\n${lines.join('\n')}\n\n` +
             `Открой Admin Panel → раздел «Заявки», чтобы подтвердить или отклонить.`;
    } else if (r.storeId && pendingMap.has(r.storeId)) {
      const p = pendingMap.get(r.storeId)!;
      text = `📋 <b>Не подтверждено заявок: ${p.pendingCount} ${plur(p.pendingCount)}</b>\n\n` +
             `На твоей точке (<b>${esc(p.storeName)}</b>) есть запросы на призы старше 24 часов.\n` +
             `Подтверди или отклони их в Admin Panel → «Заявки».`;
    }
    if (text) {
      await sendMessage(r.telegramId, text).catch(() => {});
      sent++;
    }
  }

  if (sent > 0) console.log(`[digest-pending] отправлено ${sent} напоминаний`);
}

function plur(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m100 >= 11 && m100 <= 19) return 'заявок';
  if (m10 === 1) return 'заявка';
  if (m10 >= 2 && m10 <= 4) return 'заявки';
  return 'заявок';
}
