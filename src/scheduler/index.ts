import cron from 'node-cron';
import https from 'https';
import http from 'http';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot/context';
import { pool } from '../db/pool';
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

  const serviceUrl = (
    process.env.WEBHOOK_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    'https://maria-crew.onrender.com'
  ).replace(/\/$/, '');

  // ── 4. Render keep-alive — пинг каждые 13 минут ──────────────────────────
  // Render free tier засыпает через 15 мин без трафика
  cron.schedule('*/13 * * * *', () => {
    try {
      const url = `${serviceUrl}/api/health`;
      const client = url.startsWith('https') ? https : http;
      client.get(url, (res) => {
        if (res.statusCode !== 200) console.warn('[keep-alive] health вернул', res.statusCode);
      }).on('error', (err) => {
        console.warn('[keep-alive] ping ошибка:', err.message);
      });
    } catch (err) {
      console.error('[keep-alive] неожиданная ошибка:', err);
    }
  });

  // ── 5. Neon keep-alive — запрос к БД каждую минуту ─────────────────────
  // Neon free tier засыпает через 60-300с без запросов. Пинг каждую минуту
  // гарантирует, что compute всегда активна и пул уже имеет живое соединение.
  cron.schedule('* * * * *', async () => {
    try {
      await pool.query('SELECT 1');
    } catch {
      // Neon просыпается — не логируем, чтобы не засорять логи
    }
  });

  console.log('[scheduler] Задачи зарегистрированы:');
  console.log('  • Каждую минуту         — Neon keep-alive');
  console.log('  • Каждые 13 мин         — Render keep-alive');
  console.log('  • Пн–Сб 09:00           — напоминание квиза в канал');
  console.log('  • 1-е число месяца 10:00 — напоминание про метрики');
  console.log('  • Пн–Сб 20:00           — напоминание про монеты');
  console.log('  • Пятница 18:00          — еженедельный дайджест в канал');
  console.log('  • Каждый день 21:00     — личное напоминание про серию');
  console.log('  • 1-е число месяца 03:00 — авто-обработка прошедшего месяца');
  console.log('  • Каждый день 03:30     — чистка журнала >6 мес');
  console.log('  • Каждый день 10:00     — дайджест непогашенных заявок');
}
