import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { webhookCallback } from 'grammy';
import type { Bot } from 'grammy';
import type { BotContext } from './bot/context';
import apiRouter from './api/router';

export function createServer(bot: Bot<BotContext>, webhookSecret: string): express.Application {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());

  // Webhook — raw body нужен grammy ДО express.json()
  app.post(
    `/webhook/${webhookSecret}`,
    webhookCallback(bot, 'express')
  );

  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true, mode: 'webhook' }));

  app.use('/api', apiRouter);

  const webappDir = path.join(__dirname, '../webapp');
  app.use('/webapp', express.static(webappDir));

  const adminDir = path.join(__dirname, '../admin');
  app.use(express.static(adminDir));
  app.get('*', (_req, res) => res.sendFile(path.join(adminDir, 'index.html')));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('API error:', err.message);
    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  });

  return app;
}
