import { InlineKeyboard } from 'grammy';
import { getPrizes, requestExchange } from '../../services/exchange.service';
import { getAvailableCardCount } from '../../services/card.service';
import { getBalance } from '../../services/coin.service';
import type { BotContext } from '../context';
import { requireAuth } from '../middleware/auth';
import { esc } from '../helpers';

// ─── /store ──────────────────────────────────────────────────────────────────

export async function handleStore(ctx: BotContext): Promise<void> {
  if (!(await requireAuth(ctx))) return;
  const employee = ctx.employee!;

  const [cards, coins] = await Promise.all([
    getAvailableCardCount(employee.id),
    getBalance(employee.id),
  ]);

  const kb = new InlineKeyboard()
    .text('🃏 Обмен карточек', 'store:cards')
    .row()
    .text('💰 Обмен монет', 'store:coins');

  await ctx.reply(
    `🛍 <b>Maria Store</b>\n\n` +
    `У тебя: <b>${cards} карточек</b> · <b>${coins} монет</b>\n\n` +
    `Выбери раздел:`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

// ─── Callback-обработчики ─────────────────────────────────────────────────────

export async function handleStoreCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';

  if (data === 'store:cards') return showPrizes(ctx, 'cards');
  if (data === 'store:coins') return showPrizes(ctx, 'coins');
  if (data === 'store:main')  return showStoreMain(ctx);

  const buyMatch     = data.match(/^store:buy:(\d+)$/);
  const confirmMatch = data.match(/^store:confirm:(\d+)$/);

  if (buyMatch)     return confirmPurchase(ctx, parseInt(buyMatch[1], 10));
  if (confirmMatch) return completePurchase(ctx, parseInt(confirmMatch[1], 10));

  await ctx.answerCallbackQuery();
}

async function showStoreMain(ctx: BotContext): Promise<void> {
  const employee = ctx.employee!;
  const [cards, coins] = await Promise.all([
    getAvailableCardCount(employee.id),
    getBalance(employee.id),
  ]);

  const kb = new InlineKeyboard()
    .text('🃏 Обмен карточек', 'store:cards')
    .row()
    .text('💰 Обмен монет', 'store:coins');

  const text =
    `🛍 <b>Maria Store</b>\n\n` +
    `У тебя: <b>${cards} карточек</b> · <b>${coins} монет</b>\n\n` +
    `Выбери раздел:`;

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
  await ctx.answerCallbackQuery();
}

async function showPrizes(ctx: BotContext, tab: 'cards' | 'coins'): Promise<void> {
  const employee = ctx.employee!;
  const [prizes, cardCount, coinBalance] = await Promise.all([
    getPrizes(),
    getAvailableCardCount(employee.id),
    getBalance(employee.id),
  ]);

  const filtered = prizes.filter(p =>
    tab === 'cards' ? p.cardsRequired > 0 : p.coinsRequired > 0
  );

  const kb = new InlineKeyboard();
  filtered.forEach(p => {
    const canAfford = tab === 'cards'
      ? cardCount >= p.cardsRequired
      : coinBalance >= p.coinsRequired;
    kb.text(`${canAfford ? '✅' : '❌'} ${p.name}`, `store:buy:${p.id}`).row();
  });
  kb.text('« Назад', 'store:main');

  const resource = tab === 'cards'
    ? `🃏 Карточек: <b>${cardCount}</b>`
    : `💰 Монет: <b>${coinBalance}</b>`;

  const header = tab === 'cards'
    ? '🃏 <b>Обмен карточек</b>'
    : '💰 <b>Обмен монет</b>';

  const listText = filtered.length > 0
    ? filtered.map(p => {
        const cost = tab === 'cards'
          ? `${p.cardsRequired} карт.`
          : `${p.coinsRequired} монет`;
        const canAfford = tab === 'cards'
          ? cardCount >= p.cardsRequired
          : coinBalance >= p.coinsRequired;
        return `${canAfford ? '✅' : '❌'} <b>${esc(p.name)}</b> — ${cost}`;
      }).join('\n')
    : '<i>Нет доступных призов</i>';

  await ctx.editMessageText(
    `${header}\n${resource}\n\n${listText}\n\n<i>Нажми на приз, чтобы обменять</i>`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
  await ctx.answerCallbackQuery();
}

async function confirmPurchase(ctx: BotContext, prizeId: number): Promise<void> {
  const prizes = await getPrizes();
  const prize = prizes.find(p => p.id === prizeId);
  if (!prize) { await ctx.answerCallbackQuery('Приз не найден'); return; }

  const employee = ctx.employee!;
  const [cardCount, coinBalance] = await Promise.all([
    getAvailableCardCount(employee.id),
    getBalance(employee.id),
  ]);

  const isCardPrize = prize.cardsRequired > 0;
  const cost = isCardPrize
    ? `${prize.cardsRequired} карточки`
    : `${prize.coinsRequired} монет`;

  const canAfford = isCardPrize
    ? cardCount >= prize.cardsRequired
    : coinBalance >= prize.coinsRequired;

  if (!canAfford) {
    await ctx.answerCallbackQuery({ text: 'Недостаточно ресурсов 😔', show_alert: true });
    return;
  }

  const tab = isCardPrize ? 'cards' : 'coins';
  const kb = new InlineKeyboard()
    .text('✅ Подтвердить', `store:confirm:${prizeId}`)
    .text('❌ Отмена', 'store:main');

  await ctx.editMessageText(
    `🛍 <b>Подтвердить обмен?</b>\n\n` +
    `Приз: <b>${esc(prize.name)}</b>\n` +
    `Стоимость: <b>${cost}</b>\n\n` +
    `После подтверждения ресурсы будут списаны.`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
  await ctx.answerCallbackQuery();
}

async function completePurchase(ctx: BotContext, prizeId: number): Promise<void> {
  const employee = ctx.employee!;
  try {
    await requestExchange(employee.id, prizeId);
    await ctx.editMessageText(
      `✅ <b>Заявка принята!</b>\n\n` +
      `Руководитель подтвердит выдачу приза.\n\n` +
      `Вернуться: /store`,
      { parse_mode: 'HTML' }
    );
    await ctx.answerCallbackQuery('Заявка отправлена! 🎉');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Ошибка';
    await ctx.answerCallbackQuery({ text: message, show_alert: true });
  }
}
