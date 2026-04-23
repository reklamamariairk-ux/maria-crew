import { pool } from '../../db/pool';
import type { BotContext } from '../context';
import { requireAuth } from '../middleware/auth';
import { esc } from '../helpers';

export async function handleCrew(ctx: BotContext): Promise<void> {
  if (!(await requireAuth(ctx))) return;
  const employee = ctx.employee!;

  // Имя точки
  const { rows: storeRows } = await pool.query<{ name: string }>(
    `SELECT name FROM stores WHERE id = $1`,
    [employee.storeId]
  );
  const storeName = storeRows[0]?.name ?? '';

  // Все активные сотрудники точки
  const { rows: members } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM employees WHERE store_id = $1 AND is_active = true ORDER BY name`,
    [employee.storeId]
  );

  if (members.length === 0) {
    await ctx.reply('В команде пока нет зарегистрированных сотрудников.');
    return;
  }

  // Для каждого — количество уникальных основных героев и доступных карточек
  const stats = await Promise.all(
    members.map(async m => {
      const { rows } = await pool.query<{ uniqueHeroes: string; available: string }>(
        `SELECT
           COUNT(DISTINCT ec.hero_id) FILTER (WHERE h.is_limited = false) AS "uniqueHeroes",
           COUNT(ec.id) FILTER (WHERE ec.is_spent = false)                AS available
         FROM employee_cards ec
         JOIN heroes h ON h.id = ec.hero_id
         WHERE ec.employee_id = $1`,
        [m.id]
      );
      return {
        ...m,
        uniqueHeroes: parseInt(rows[0].uniqueHeroes, 10),
        available: parseInt(rows[0].available, 10),
      };
    })
  );

  // Сортируем по uniqueHeroes DESC
  stats.sort((a, b) => b.uniqueHeroes - a.uniqueHeroes);

  // Какие из 12 героев есть у команды в целом
  const { rows: teamHeroRows } = await pool.query<{ heroId: number; heroName: string }>(
    `SELECT DISTINCT ec.hero_id AS "heroId", h.name AS "heroName"
     FROM employee_cards ec
     JOIN heroes h ON h.id = ec.hero_id
     JOIN employees e ON e.id = ec.employee_id
     WHERE e.store_id = $1 AND h.is_limited = false`,
    [employee.storeId]
  );
  const { rows: allHeroRows } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM heroes WHERE is_limited = false ORDER BY sort_order`
  );

  const teamHeroIds = new Set(teamHeroRows.map(r => r.heroId));
  const missing = allHeroRows.filter(h => !teamHeroIds.has(h.id));

  let text =
    `👥 <b>Crew — ${esc(storeName)}</b>\n` +
    `Команда: ${members.length} чел. · Героев в коллективе: ${teamHeroIds.size}/12\n\n` +
    `<b>Кто ближе к полной Crew:</b>\n`;

  stats.forEach((m, i) => {
    const isSelf = m.id === employee.id;
    const prefix = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const selfMark = isSelf ? ' ◀ ты' : '';
    text += `${prefix} ${esc(m.name)} — ${m.uniqueHeroes}/12 героев${selfMark}\n`;
  });

  if (missing.length === 0) {
    text += `\n🏆 <b>Команда собрала всех 12 героев!</b>`;
  } else {
    const missingNames = missing.map(h => esc(h.name)).join(', ');
    text += `\n<b>Не хватает команде:</b> ${missingNames}`;
  }

  await ctx.reply(text, { parse_mode: 'HTML' });
}
