import { pool } from '../../db/pool';
import { monthName } from '../../bot/helpers';

/**
 * Запускается каждую пятницу в 18:00.
 * Публикует в Telegram-канал промежуточные итоги месяца:
 * кто лидирует по карточкам и монетам.
 */
export async function weeklyDigest(
  publishToChannel: (html: string) => Promise<void>
): Promise<void> {
  // Иркутское время — синхронно с месячными агрегациями в остальной системе.
  // Cron запускается в пятницу 18:00 Иркутск, но если когда-нибудь сместится
  // ближе к границе месяца, без timezone был бы риск выбора соседнего месяца.
  const irk = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const year = irk.getUTCFullYear();
  const month = irk.getUTCMonth() + 1;
  const day = irk.getUTCDate();

  // Топ-5 по карточкам в текущем месяце
  const { rows: topCards } = await pool.query<{
    name: string; storeName: string; cards: number;
  }>(
    `SELECT e.name, s.name AS "storeName", COUNT(ec.id)::int AS cards
     FROM employee_cards ec
     JOIN employees e ON e.id = ec.employee_id
     JOIN stores s ON s.id = e.store_id
     WHERE ec.year = $1 AND ec.month = $2
     GROUP BY e.id, e.name, s.name
     ORDER BY cards DESC
     LIMIT 5`,
    [year, month]
  );

  // Топ-5 по монетам за месяц
  const { rows: topCoins } = await pool.query<{
    name: string; storeName: string; earned: number;
  }>(
    `SELECT e.name, s.name AS "storeName",
            SUM(ct.amount) FILTER (WHERE ct.amount > 0)::int AS earned
     FROM coin_transactions ct
     JOIN employees e ON e.id = ct.employee_id
     JOIN stores s ON s.id = e.store_id
     WHERE EXTRACT(YEAR  FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $1
       AND EXTRACT(MONTH FROM ct.created_at AT TIME ZONE 'Asia/Irkutsk') = $2
     GROUP BY e.id, e.name, s.name
     ORDER BY earned DESC NULLS LAST
     LIMIT 5`,
    [year, month]
  );

  if (topCards.length === 0 && topCoins.length === 0) return;

  const MEDALS = ['🥇', '🥈', '🥉', '4.', '5.'];

  let text = `📊 <b>Итоги недели — ${monthName(month, true)} ${year}</b>\n\n`;

  if (topCards.length > 0) {
    text += `🃏 <b>Больше всего карточек в этом месяце:</b>\n`;
    topCards.forEach((r, i) => {
      text += `${MEDALS[i]} ${r.name} (${r.storeName}) — ${r.cards} карт.\n`;
    });
    text += '\n';
  }

  if (topCoins.length > 0) {
    text += `💰 <b>Больше всего монет заработали:</b>\n`;
    topCoins.forEach((r, i) => {
      text += `${MEDALS[i]} ${r.name} (${r.storeName}) — ${r.earned} монет\n`;
    });
    text += '\n';
  }

  // Сколько дней до конца месяца — считаем по иркутской дате
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysLeft = daysInMonth - day;
  text += `⏳ До конца месяца: <b>${daysLeft} ${dayWord(daysLeft)}</b>\n`;
  text += `Смотри свой рейтинг: /rating`;

  await publishToChannel(text);
  console.log(`[scheduler] weeklyDigest: опубликован дайджест за ${monthName(month)} ${year}`);
}

function dayWord(n: number): string {
  if (n === 1) return 'день';
  if (n >= 2 && n <= 4) return 'дня';
  return 'дней';
}
