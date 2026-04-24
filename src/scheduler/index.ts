import cron from 'node-cron';
import https from 'https';
import http from 'http';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot/context';
import { remindMetrics } from './jobs/remindMetrics';
import { remindDailyCoins } from './jobs/remindDailyCoins';
import { weeklyDigest } from './jobs/weeklyDigest';

/**
 * Регистрирует все cron-задачи.
 * Вызывается один раз при старте приложения.
 */
export function initScheduler(bot: Bot<BotContext>): void {
  // Вспомогательная функция — отправить сообщение пользователю
  const sendMessage = async (telegramId: string, html: string): Promise<void> => {
    try {
      await bot.api.sendMessage(telegramId, html, { parse_mode: 'HTML' });
    } catch {
      // Пользователь заблокировал бота
    }
  };

  // Опубликовать в канал Maria Crew
  const publishToChannel = async (html: string): Promise<void> => {
    const channelId = process.env.CREW_CHANNEL_ID;
    if (!channelId) return;
    try {
      await bot.api.sendMessage(channelId, html, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[scheduler] Ошибка публикации в канал:', err);
    }
  };

  // ── 1. Ежемесячное напоминание руководителям ──────────────────────────────
  // 1-го числа каждого месяца в 10:00 (Иркутск UTC+8 = UTC 02:00)
  cron.schedule('0 2 1 * *', async () => {
    console.log('[scheduler] remindMetrics — запуск');
    await remindMetrics(sendMessage);
  }, { timezone: 'Asia/Irkutsk' });

  // ── 2. Ежедневное напоминание про монеты ─────────────────────────────────
  // Будни (пн-сб) в 20:00 по Иркутску
  cron.schedule('0 20 * * 1-6', async () => {
    console.log('[scheduler] remindDailyCoins — запуск');
    await remindDailyCoins(sendMessage);
  }, { timezone: 'Asia/Irkutsk' });

  // ── 3. Еженедельный дайджест в канал ─────────────────────────────────────
  // Каждую пятницу в 18:00 по Иркутску
  cron.schedule('0 18 * * 5', async () => {
    console.log('[scheduler] weeklyDigest — запуск');
    await weeklyDigest(publishToChannel);
  }, { timezone: 'Asia/Irkutsk' });

  // ── 4. Keep-alive — пинг каждые 13 минут ─────────────────────────────────
  // Render free tier засыпает через 15 мин без трафика
  const serviceUrl = (process.env.WEBHOOK_URL ?? 'https://maria-crew.onrender.com').replace(/\/$/, '');
  cron.schedule('*/13 * * * *', () => {
    const url = `${serviceUrl}/api/health`;
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode !== 200) console.warn('[keep-alive] health вернул', res.statusCode);
    }).on('error', (err) => {
      console.warn('[keep-alive] ping ошибка:', err.message);
    });
  });

  console.log('[scheduler] Задачи зарегистрированы:');
  console.log('  • Каждые 13 мин         — keep-alive ping');
  console.log('  • 1-е число месяца 10:00 — напоминание про метрики');
  console.log('  • Пн–Сб 20:00           — напоминание про монеты');
  console.log('  • Пятница 18:00          — еженедельный дайджест в канал');
}
