import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import apiRouter from './api/router';

export function createServer(): express.Application {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json());

  // Health check для Railway
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // API
  app.use('/api', apiRouter);

  // Admin panel — статические файлы
  const adminDir = path.join(__dirname, '../admin');
  app.use(express.static(adminDir));
  app.get('*', (_req, res) => res.sendFile(path.join(adminDir, 'index.html')));

  return app;
}
