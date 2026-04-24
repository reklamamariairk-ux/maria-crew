import { Bot, session } from 'grammy';
import type { BotContext, SessionData } from './context';
import { authMiddleware } from './middleware/auth';
import { handleStart } from './commands/start';
import { handleCollection } from './commands/collection';
import { handleCoins } from './commands/coins';
import { handleRating } from './commands/rating';
import { handleTop } from './commands/top';
import { handleStore, handleStoreCallback } from './commands/store';
import { handleCrew } from './commands/crew';

export function createBot(token: string): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  bot.use(session({ initial: (): SessionData => ({ step: 'idle' }) }));
  bot.use(authMiddleware);

  bot.command('start',      handleStart);
  bot.command('collection', handleCollection);
  bot.command('coins',      handleCoins);
  bot.command('rating',     handleRating);
  bot.command('top',        handleTop);
  bot.command('store',      handleStore);
  bot.command('crew',       handleCrew);

  bot.callbackQuery(/^store:/, handleStoreCallback);

  bot.catch(err => {
    console.error('Bot error:', err.error);
  });

  return bot;
}
