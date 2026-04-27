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
  cron.schedule('0 9 * * 1-6', async () => {
    console.log('[scheduler] remindQuiz — запуск');
    await remindQuiz(publishToChannel);
  }, { timezone: 'Asia/Irkutsk' });

  // ── 1. Ежемесячное напоминание руководителям ──────────────────────────────
  cron.schedule('0 2 1 * *', async () => {
    console.log('[scheduler] remindMetrics — запуск');
    await remindMetrics(sendMessage);
  }, { timezone: 'Asia/Irkutsk' });

  // ── 2. Ежедневное напоминание про монеты ─────────────────────────────────
  cron.schedule('0 20 * * 1-6', async () => {
    console.log('[scheduler] remindDailyCoins — запуск');
    await remindDailyCoins(sendMessage);
  }, { timezone: 'Asia/Irkutsk' });

  // ── 3. Еженедельный дайджест в канал ─────────────────────────────────────
  cron.schedule('0 18 * * 5', async () => {
    console.log('[scheduler] weeklyDigest — запуск');
    await weeklyDigest(publishToChannel);
  }, { timezone: 'Asia/Irkutsk' });

  const serviceUrl = (
    process.env.WEBHOOK_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    'https://maria-crew.onrender.com'
  ).replace(/\/$/, '');

  // ── 4. Render keep-alive — пинг каждые 13 минут ──────────────────────────
  // Render free tier засыпает через 15 мин без трафика
  cron.schedule('*/13 * * * *', () => {
    const url = `${serviceUrl}/api/health`;
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode !== 200) console.warn('[keep-alive] health вернул', res.statusCode);
    }).on('error', (err) => {
      console.warn('[keep-alive] ping ошибка:', err.message);
    });
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
}
