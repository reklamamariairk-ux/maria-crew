import { NextFunction } from 'grammy';
import { pool } from '../../db/pool';
import type { BotContext } from '../context';
import type { Employee } from '../../types';

export async function authMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId) {
    const { rows } = await pool.query<Employee>(
      `SELECT * FROM employees WHERE telegram_id = $1 AND is_active = true`,
      [telegramId]
    );
    ctx.employee = rows[0];
  }
  await next();
}

/** Хелпер для команд, требующих авторизации */
export async function requireAuth(ctx: BotContext): Promise<boolean> {
  if (ctx.employee) return true;
  await ctx.reply('Сначала зарегистрируйся — отправь /start');
  return false;
}
