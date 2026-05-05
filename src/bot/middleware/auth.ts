import { NextFunction } from 'grammy';
import { pool } from '../../db/pool';
import type { BotContext } from '../context';
import type { Employee } from '../../types/index';

export async function authMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId) {
    try {
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
           SET telegram_id = $1, telegram_username = $2
           WHERE LOWER(telegram_username) = $2 AND is_active = true AND telegram_id IS NULL
           RETURNING *`,
          [telegramId, username]
        );
        rows = linked.rows;
      }

      // 3. Нашли по id — но Telegram username мог измениться. Синхронизируем
      // (без блокировки запроса — fire and forget)
      if (rows[0] && ctx.from.username) {
        const currentUsername = ctx.from.username.toLowerCase();
        const dbUsername = (rows[0].telegramUsername ?? '').toLowerCase();
        if (currentUsername !== dbUsername) {
          pool.query(
            `UPDATE employees SET telegram_username = $1 WHERE id = $2`,
            [currentUsername, rows[0].id]
          ).catch(err => console.error('[auth] sync username failed:', err instanceof Error ? err.message : err));
        }
      }

      ctx.employee = rows[0];
    } catch (err) {
      console.error('[auth] DB error:', err);
      // Продолжаем без employee — handleStart покажет форму выбора точки
    }
  }
  await next();
}

export async function requireAuth(ctx: BotContext): Promise<boolean> {
  if (ctx.employee) return true;
  await ctx.reply(
    '❌ Тебя нет в системе.\n\nОтправь /start чтобы зарегистрироваться.'
  );
  return false;
}
