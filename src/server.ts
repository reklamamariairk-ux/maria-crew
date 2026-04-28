import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { webhookCallback } from 'grammy';
import type { Bot } from 'grammy';
import type { BotContext } from './bot/context';
import apiRouter from './api/router';
import { getDiagnostics, markBotError, markWebhookHit } from './diagnostics';

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
  app.get('*', (_req, res) => res.sendFile(path.join(adminDir, 'index.html')));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('API error:', err.message);
    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  });

  return app;
}
