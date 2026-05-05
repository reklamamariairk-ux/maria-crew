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

  // Имена точек одним запросом (раньше делали по одному в цикле)
  const storeIds = results.map(r => r.storeId);
  const { rows: storeRows } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM stores WHERE id = ANY($1)`, [storeIds]
  );
  const storeNames = new Map(storeRows.map(s => [s.id, s.name]));

  // Уведомления — параллельно через Promise.allSettled.
  // Иначе при 16 точках × секунда на каждый push последовательная отправка
  // может растянуться на минуту+, блокируя cron-слот.
  const tasks: Promise<unknown>[] = [];
  for (const result of results) {
    const storeName = storeNames.get(result.storeId) ?? '';
    const mvp = result.employees.find(e => e.isMvp);
    if (mvp) tasks.push(notifyMvp(mvp.employeeId, storeName, month, year, mvp.mvpScore));
    if (result.topStore) tasks.push(notifyTopStore(result.storeId, storeName, month, year, result.storeScore));
  }
  tasks.push(publishMonthResults(results, month, year));

  const outcomes = await Promise.allSettled(tasks);
  const failed = outcomes.filter(r => r.status === 'rejected').length;
  if (failed > 0) {
    console.warn(`[auto-process] ${failed} уведомлений не доставлено (см. предыдущие логи)`);
    outcomes.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`[auto-process] notify[${i}] failed:`, r.reason);
    });
  }

  console.log(`[auto-process] done: ${results.length} stores processed, ${tasks.length - failed}/${tasks.length} notifications sent`);
  logAudit('metrics_process', { auto: true, year, month, storeIds }).catch(() => {});
}
