import { NextFunction } from 'grammy';
import { pool } from '../../db/pool';
import type { BotContext } from '../context';
import type { Employee } from '../../types';

export async function authMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId) {
    // 1. Ищем по telegram_id (уже привязан)
    let { rows } = await pool.query<Employee>(
      `SELECT * FROM employees WHERE telegram_id = $1 AND is_active = true`,
      [telegramId]
    );

    // 2. Не нашли — пробуем по username и привязываем
    if (!rows[0] && ctx.from.username) {
      const username = ctx.from.username.toLowerCase();
      const linked = await pool.query<Employee>(
        `UPDATE employees
         SET telegram_id = $1
         WHERE LOWER(telegram_username) = $2 AND is_active = true AND telegram_id IS NULL
         RETURNING *`,
        [telegramId, username]
      );
      rows = linked.rows;
    }

    ctx.employee = rows[0];
  }
  await next();
}

export async function requireAuth(ctx: BotContext): Promise<boolean> {
  if (ctx.employee) return true;
  await ctx.reply(
    '❌ Тебя нет в системе.\n\nПопроси руководителя добавить тебя в Maria Crew — ' +
    'он укажет твой Telegram @username при регистрации.'
  );
  return false;
}
