import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import apiRouter from './api/router';

export function createServer(): express.Application {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use('/api', apiRouter);

  // Admin panel — статические файлы
  const adminDir = path.join(__dirname, '../admin');
  app.use(express.static(adminDir));
  app.get('*', (_req, res) => res.sendFile(path.join(adminDir, 'index.html')));

  // Глобальный обработчик ошибок
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('API error:', err.message);
    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  });

  return app;
}
