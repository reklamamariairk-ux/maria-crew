import { pool } from '../../db/pool';
import { processMonthAllStores } from '../../services/rating.service';
import { notifyMvp, notifyTopStore, publishMonthResults } from '../../bot/notifications/sender';
import { logAudit } from '../../services/audit.service';

/**
 * 1-го числа каждого месяца в 03:00 Иркутска: автоматически обрабатывает прошедший месяц.
 * - Считает MVP / топ-точку
 * - Раздаёт карточки и бонус-монеты (через processMonthAllStores)
 * - Уведомляет сотрудников + публикует итоги в канал
 *
 * Идемпотентно — повторный запуск (или ручное «Обработать месяц») не задвоит карточки/монеты.
 */
export async function autoProcessMonth(): Promise<void> {
  // Считаем «прошедший месяц» по Иркутскому времени
  const irk = new Date(Date.now() + 8 * 60 * 60 * 1000);
  let year = irk.getUTCFullYear();
  let month = irk.getUTCMonth(); // прошлый месяц (0-индекс) уже = текущий месяц −1, но getUTCMonth+1 = текущий
  if (month === 0) { month = 12; year -= 1; } // декабрь предыдущего года
  // month теперь 1..12 — это прошедший месяц

  console.log(`[auto-process] start: ${month}/${year}`);

  // Используем существующие рейтинги точек, если есть; пустая Map — processMonth подтянет из БД
  const results = await processMonthAllStores(year, month, new Map());

  for (const result of results) {
    const { rows: storeRows } = await pool.query<{ name: string }>(
      `SELECT name FROM stores WHERE id = $1`, [result.storeId]
    );
    const storeName = storeRows[0]?.name ?? '';
    const mvp = result.employees.find(e => e.isMvp);
    if (mvp) await notifyMvp(mvp.employeeId, storeName, month, year, mvp.mvpScore).catch(err =>
      console.error('[auto-process] notifyMvp failed:', err instanceof Error ? err.message : err));
    if (result.topStore) await notifyTopStore(result.storeId, storeName, month, year, result.storeScore).catch(err =>
      console.error('[auto-process] notifyTopStore failed:', err instanceof Error ? err.message : err));
  }

  await publishMonthResults(results, month, year).catch(err =>
    console.error('[auto-process] publishMonthResults failed:', err instanceof Error ? err.message : err));

  console.log(`[auto-process] done: ${results.length} stores processed`);
  logAudit('metrics_process', { auto: true, year, month, storeIds: results.map(r => r.storeId) }).catch(() => {});
}
