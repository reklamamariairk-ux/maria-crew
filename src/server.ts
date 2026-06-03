import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { webhookCallback } from 'grammy';
import type { Bot } from 'grammy';
import type { BotContext } from './bot/context';
import apiRouter from './api/router';
import { getDiagnostics, getCronStatus, markBotError, markWebhookHit } from './diagnostics';
import { pool } from './db/pool';

export function createServer(bot: Bot<BotContext>, webhookSecret: string): express.Application {
  const app = express();
  // Render/Railway используют reverse proxy — доверяем первому hop для req.ip
  app.set('trust proxy', 1);
  const telegramWebhook = webhookCallback(bot, 'express', {
    onTimeout: 'return',
    timeoutMilliseconds: 25000,
  });

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    frameguard: false,
  }));
  app.use(cors());
  app.use(express.json());

  // Для express-адаптера grammy нужен уже распарсенный JSON body.
  app.post(`/webhook/${webhookSecret}`, async (req, res, next) => {
    const update = req.body;
    markWebhookHit(update);
    if (!update || typeof update !== 'object' || typeof update.update_id !== 'number') {
      console.error('[webhook] Некорректный payload:', update);
      res.status(400).json({ error: 'Invalid Telegram update payload' });
      return;
    }

    try {
      await telegramWebhook(req, res);
    } catch (err) {
      console.error('[webhook] Ошибка обработки update:', err);
      markBotError(err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        res.status(500).json({ error: 'Webhook processing failed' });
      } else {
        next(err);
      }
    }
  });

  app.get('/api/health', (_req, res) => res.json({
    ok: true,
    mode: 'webhook',
    diagnostics: getDiagnostics(),
  }));

  // Детальный health-check для UptimeRobot/мониторинга. Возвращает 503 если:
  //   - БД не отвечает
  //   - cron autoProcessMonth не запускался > 35 дней (должен раз в месяц)
  //   - последняя ошибка бота свежее 5 минут назад
  app.get('/api/health/detailed', async (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    let overallOk = true;

    // 1. БД
    try {
      await pool.query('SELECT 1');
      checks.db = { ok: true };
    } catch (err) {
      checks.db = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      overallOk = false;
    }

    // 2. Cron-статусы — какие задачи давно не запускались (но только те, что должны были)
    const cronStatuses = getCronStatus();
    const now = Date.now();
    const cronChecks: Record<string, { lastRunAt?: string; lastSuccess: boolean; ageHours?: number }> = {};
    for (const [name, status] of Object.entries(cronStatuses)) {
      const ageMs = now - new Date(status.lastRunAt).getTime();
      cronChecks[name] = {
        lastRunAt: status.lastRunAt,
        lastSuccess: status.lastSuccess,
        ageHours: Math.round(ageMs / 3600_000 * 10) / 10,
      };
      if (!status.lastSuccess) overallOk = false;
    }
    checks.crons = { ok: Object.values(cronStatuses).every(s => s.lastSuccess), detail: JSON.stringify(cronChecks) };

    // 3. Бот — была ли свежая ошибка
    const diag = getDiagnostics();
    const lastBotError = diag.lastBotError as { at: string; message: string } | null;
    if (lastBotError) {
      const ageMs = now - new Date(lastBotError.at).getTime();
      if (ageMs < 5 * 60 * 1000) {
        checks.bot = { ok: false, detail: `Recent error: ${lastBotError.message}` };
        overallOk = false;
      } else {
        checks.bot = { ok: true, detail: `Last error: ${Math.round(ageMs / 60_000)} min ago` };
      }
    } else {
      checks.bot = { ok: true };
    }

    res.status(overallOk ? 200 : 503).json({
      ok: overallOk,
      checks,
      diagnostics: diag,
    });
  });

  app.use('/api', apiRouter);

  const webappDir = path.join(__dirname, '../webapp');
  app.use('/webapp', express.static(webappDir, {
    etag: false,
    lastModified: false,
    setHeaders: res => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    },
  }));

  const adminDir = path.join(__dirname, '../admin');
  app.use(express.static(adminDir));
  // Старый URL `/admin/*` (когда-то static был смонтирован сюда) теперь
  // отдавался fallback-ом app.get('*', ...) — браузер получал index.html
  // вместо app.js и style.css, и страница тихо ломалась с CSP MIME ошибкой.
  // Постоянно редиректим /admin → / (статика смонтирована на корень).
  app.get(/^\/admin(\/.*)?$/, (req, res) => {
    const tail = req.path.replace(/^\/admin\/?/, '');
    res.redirect(301, '/' + tail);
  });
  // Публичная страница Политики конфиденциальности — требуется для подачи
  // в App Store / Google Play (постоянный URL). Не закрыта авторизацией,
  // короткий URL без .html для использования в маркетах.
  app.get('/privacy', (_req, res) => res.sendFile(path.join(adminDir, 'privacy.html')));
  app.get('*', (_req, res) => res.sendFile(path.join(adminDir, 'index.html')));

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error(`API error [${req.method} ${req.path}]:`, err.message);
    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  });

  return app;
}
