/**
 * Запускается каждый будний день в 09:00 (Иркутск).
 * Публикует в канал напоминание пройти ежедневный квиз.
 */
export async function remindQuiz(
  publishToChannel: (html: string) => Promise<void>
): Promise<void> {
  const messages = [
    '🧩 <b>Доброе утро, команда!</b>\n\nНе забудьте про ежедневный квиз — 5 вопросов и до <b>+5 монет</b>.\nОткройте Maria Crew и отвечайте!',
    '☕ <b>Новый день — новый квиз!</b>\n\n5 вопросов про продукцию и сервис. Правильный ответ = +1 монета.\nУже проверили свои знания сегодня? 🧩',
    '🌅 <b>Квиз дня ждёт вас!</b>\n\nЗаходите в Maria Crew → вкладка «Квиз» и зарабатывайте монеты.\nС каждым днём вы знаете продукцию «Мария» лучше! 💪',
  ];
  const text = messages[new Date().getDay() % messages.length];
  await publishToChannel(text);
  console.log('[scheduler] remindQuiz: напоминание опубликовано');
}
