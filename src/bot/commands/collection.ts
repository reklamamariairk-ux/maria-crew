import { pool } from '../../db/pool';
import { getCollection } from '../../services/card.service';
import type { BotContext } from '../context';
import { requireAuth } from '../middleware/auth';
import { esc } from '../helpers';

export async function handleCollection(ctx: BotContext): Promise<void> {
  if (!(await requireAuth(ctx))) return;
  const employee = ctx.employee!;

  const summary = await getCollection(employee.id);

  // Загружаем всех 12 основных героев для отображения сетки
  const { rows: heroes } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM heroes WHERE is_limited = false ORDER BY sort_order`
  );

  // Какие герои есть у сотрудника (из всех карточек, включая потраченные)
  const owned = new Set(summary.cards.map(c => c.heroId));

  const grid = heroes
    .map(h => `${owned.has(h.id) ? '✅' : '⬜'} ${esc(h.name)}`)
    .join('\n');

  const { rows: limitedCards } = await pool.query<{ heroName: string; earnedAt: Date }>(
    `SELECT h.name AS "heroName", ec.earned_at AS "earnedAt"
     FROM employee_cards ec
     JOIN heroes h ON h.id = ec.hero_id
     WHERE ec.employee_id = $1 AND h.is_limited = true`,
    [employee.id]
  );

  let text =
    `🃏 <b>Моя коллекция</b>\n` +
    `${esc(employee.name)}\n\n` +
    `<b>12 основных героев:</b>\n` +
    `${grid}\n\n` +
    `📊 Уникальных: <b>${summary.uniqueHeroes}/12</b>  ` +
    `· Всего карточек: <b>${summary.totalCards}</b>  ` +
    `· Доступно: <b>${summary.availableCards}</b>`;

  if (limitedCards.length > 0) {
    const lim = limitedCards.map(c => `⭐ ${esc(c.heroName)}`).join('\n');
    text += `\n\n<b>Лимитные карточки:</b>\n${lim}`;
  }

  if (summary.hasFullCollection) {
    text += '\n\n🏆 <b>Полная Crew собрана!</b> Легендарный статус.';
  } else {
    const left = 12 - summary.uniqueHeroes;
    text += `\n\nДо полной Crew: <b>${left} ${heroWord(left)}</b> 💪`;
  }

  await ctx.reply(text, { parse_mode: 'HTML' });
}

function heroWord(n: number): string {
  if (n === 1) return 'герой';
  if (n >= 2 && n <= 4) return 'героя';
  return 'героев';
}
