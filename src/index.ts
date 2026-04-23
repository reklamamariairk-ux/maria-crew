import dotenv from 'dotenv';
dotenv.config();

import { createBot } from './bot/bot';
import { createServer } from './server';
import { initNotifications } from './bot/notifications/sender';
import { initScheduler } from './scheduler';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN не задан в .env');

const port = parseInt(process.env.PORT ?? '3000', 10);

const bot = createBot(token);
initNotifications(bot);
initScheduler(bot);

const app = createServer();
app.listen(port, () => console.log(`Admin panel: http://localhost:${port}`));

bot.start({
  onStart: info => console.log(`Maria Crew bot @${info.username} запущен`),
});
