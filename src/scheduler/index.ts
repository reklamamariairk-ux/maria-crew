import cron from 'node-cron';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot/context';
import { remindMetrics } from './jobs/remindMetrics';
import { remindDailyCoins } from './jobs/remindDailyCoins';
import { weeklyDigest } from './jobs/weeklyDigest';
import { remindQuiz } from './jobs/remindQuiz';
import { remindStreak } from './jobs/remindStreak';
import { autoProcessMonth } from './jobs/autoProcessMonth';
import { auditRetention } from './jobs/auditRetention';
import { digestPendingExchanges } from './jobs/digestPendingExchanges';
import { markCronRun } from '../diagnostics';
import { alertOwner } from '../bot/notifications/sender';
import { refreshCatalog, isProxyConfigured } from '../services/oneCCatalog.service';
import { remindUnansweredRequests } from '../services/request.service';

/** Обёртка над cron-задачей: ловит ошибки, обновляет статус, шлёт алерт владельцу */
function safeRun(name: string, fn: () => Promise<void>, alertOnError = false): () => Promise<void> {
  return async () => {
    try {
      await fn();
      markCronRun(name, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] ${name} error:`, err);
      markCronRun(name, false, msg);
      if (alertOnError) {
        alertOwner(`Cron ${name} упал:\n${msg}`).catch(() => {});
      }
    }
  };
}

export function initScheduler(bot: Bot<BotContext>): void {
  const sendMessage = async (telegramId: string, html: string): Promise<void> => {
    try {
      await bot.api.sendMessage(telegramId, html, { parse_mode: 'HTML' });
    } catch { /* пользователь заблокировал бота */ }
  };

  const publishToChannel = async (html: string): Promise<void> => {
    const channelId = process.env.CREW_CHANNEL_ID;
    if (!channelId) return;
    try {
      await bot.api.sendMessage(channelId, html, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[scheduler] Ошибка публикации в канал:', err);
    }
  };

  // ── 0. Утреннее напоминание квиза в канал (Пн–Сб 09:00) ─────────────────
  cron.schedule('0 9 * * 1-6', safeRun('remindQuiz', () => remindQuiz(publishToChannel)),
    { timezone: 'Asia/Irkutsk' });

  // ── 1. Ежемесячное напоминание руководителям (1-го числа в 10:00 Иркутск) ─
  cron.schedule('0 10 1 * *', safeRun('remindMetrics', () => remindMetrics(sendMessage), true),
    { timezone: 'Asia/Irkutsk' });

  // ── 2. Ежедневное напоминание про монеты ─────────────────────────────────
  cron.schedule('0 20 * * 1-6', safeRun('remindDailyCoins', () => remindDailyCoins(sendMessage)),
    { timezone: 'Asia/Irkutsk' });

  // ── 3. Еженедельный дайджест в канал ─────────────────────────────────────
  cron.schedule('0 18 * * 5', safeRun('weeklyDigest', () => weeklyDigest(publishToChannel)),
    { timezone: 'Asia/Irkutsk' });

  // ── 3b. Личное напоминание про серию (21:00 ежедневно) ───────────────────
  cron.schedule('0 21 * * *', safeRun('remindStreak', () => remindStreak(sendMessage)),
    { timezone: 'Asia/Irkutsk' });

  // ── 3c. Авто-обработка прошедшего месяца (1-го числа в 03:00) ────────────
  // alertOnError=true — если упадёт, владельцу прилетит push в Telegram
  cron.schedule('0 3 1 * *', safeRun('autoProcessMonth', autoProcessMonth, true),
    { timezone: 'Asia/Irkutsk' });

  // ── 3d. Чистка журнала старше 6 месяцев (ежедневно в 03:30) ──────────────
  cron.schedule('30 3 * * *', safeRun('auditRetention', auditRetention),
    { timezone: 'Asia/Irkutsk' });

  // ── 3e. Дайджест непогашенных заявок (ежедневно в 10:00) ─────────────────
  cron.schedule('0 10 * * *', safeRun('digestPendingExchanges', () => digestPendingExchanges(sendMessage)),
    { timezone: 'Asia/Irkutsk' });

  // ── 3f. Ежедневный refresh кэша Номенклатуры 1С (04:00 Иркутск) ─────────
  // Идёт после auditRetention (03:30), до начала рабочего дня.
  // Без UPP_CATALOG_PROXY_URL — refresh пропускается, лог только.
  cron.schedule('0 4 * * *', safeRun('refreshOneCCatalog', async () => {
    if (!isProxyConfigured()) {
      console.log('[scheduler] refreshOneCCatalog: UPP_CATALOG_PROXY_URL не задан, пропускаю');
      return;
    }
    const r = await refreshCatalog();
    if (!r.ok) {
      throw new Error(`refreshCatalog: ${r.reason}`);
    }
    console.log(`[scheduler] refreshOneCCatalog: загружено ${r.total} товаров`);
  }), { timezone: 'Asia/Irkutsk' });

  // ── 3g. Напоминание о неотвеченных запросах (каждые 30 мин) ─────────────
  // Внутри запроса фильтр: прошло ≥ 2 часов И напоминания ещё не было.
  // Шлём один раз, дальше за пинками следит руководитель в админке.
  cron.schedule('*/30 * * * *', safeRun('remindUnansweredRequests', async () => {
    const r = await remindUnansweredRequests();
    if (r.sent > 0 || r.skipped > 0) {
      console.log(`[scheduler] remindUnansweredRequests: sent=${r.sent} skipped=${r.skipped}`);
    }
  }), { timezone: 'Asia/Irkutsk' });

  // Keep-alive крон'ы (Neon SELECT 1 каждую минуту, Render HTTP-пинг каждые 13 мин)
  // удалены 2026-05-21 после переезда БД на свой Postgres на VPS — локальный pg
  // не засыпает, docker compose рестартит сервис, ходить никуда не нужно.

  console.log('[scheduler] Задачи зарегистрированы:');
  console.log('  • Пн–Сб 09:00           — напоминание квиза в канал');
  console.log('  • 1-е число месяца 10:00 — напоминание про метрики');
  console.log('  • Пн–Сб 20:00           — напоминание про монеты');
  console.log('  • Пятница 18:00          — еженедельный дайджест в канал');
  console.log('  • Каждый день 21:00     — личное напоминание про серию');
  console.log('  • 1-е число месяца 03:00 — авто-обработка прошедшего месяца');
  console.log('  • Каждый день 03:30     — чистка журнала >6 мес');
  console.log('  • Каждый день 10:00     — дайджест непогашенных заявок');
  console.log('  • Каждый день 04:00     — refresh кэша Номенклатуры 1С');
  console.log('  • Каждые 30 минут       — напоминание о неотвеченных запросах (>2ч)');
}
