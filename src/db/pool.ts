import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

function camelize(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function camelizeResult(result: any): any {
  if (result && Array.isArray(result.rows)) {
    result.rows = result.rows.map((row: Record<string, unknown>) => {
      const camel: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) camel[camelize(k)] = v;
      return camel;
    });
  }
  return result;
}

const rawPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL включаем только если URL не задаёт sslmode=disable (локальный Postgres внутри
  // docker-сети). Для managed Postgres (Neon и т.п.) rejectUnauthorized:false снимает
  // проверку самоподписанных сертификатов прокси.
  ssl: /sslmode=disable/.test(process.env.DATABASE_URL ?? '') ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 120_000,
  idleTimeoutMillis: 90_000,
  max: 5,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

rawPool.on('error', (err) => {
  console.error('[pool] Неожиданная ошибка:', err.message);
});

export function camelizeRow<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) result[camelize(k)] = v;
  return result as T;
}

// Patch pool.query to auto-camelize results
const origPoolQuery = rawPool.query.bind(rawPool);
(rawPool as any).query = (...args: any[]) => {
  const lastArg = args[args.length - 1];
  if (typeof lastArg === 'function') return (origPoolQuery as any)(...args);
  return (origPoolQuery as any)(...args).then(camelizeResult);
};

export const pool = rawPool;
