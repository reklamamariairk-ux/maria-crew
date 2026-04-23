import dotenv from 'dotenv';
dotenv.config();

import { createBot } from './bot/bot';
import { createServer } from './server';
import { initNotifications } from './bot/notifications/sender';
import { initScheduler } from './scheduler';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN не задан в .env');

const port = parseInt(process.env.PORT ?? '3000', 10);

// 1. Сначала поднимаем HTTP-сервер — Railway сразу увидит healthcheck
const app = createServer();
app.listen(port, () => {
  console.log(`Admin panel запущен на порту ${port}`);

  // 2. Бот стартует после того как сервер уже слушает
  const bot = createBot(token!);
  initNotifications(bot);
  initScheduler(bot);

  bot.start({
    onStart: info => console.log(`Maria Crew bot @${info.username} запущен`),
  }).catch(err => {
    console.error('Ошибка запуска бота:', err.message);
    // Не крашим процесс — сервер продолжает работать
  });
});
