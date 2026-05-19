# Maria Crew

Программа нематериальной мотивации для сотрудников 16 кондитерских «Мария» (Иркутск).

## Что это

Telegram-бот **@Mariaprod_bot** + Mini App + Admin Panel. Сотрудники проходят квиз, отмечаются ежедневно, копят карточки героев и монеты, обменивают их на призы (от кофе до денежной премии 7 000 ₽). Руководители вносят метрики, выдают карточки, обрабатывают заявки.

Подробное описание механики — см. CHANGELOG.md.

## Стек

- **Бот**: [grammY](https://grammy.dev/) на TypeScript, webhook-режим
- **Mini App**: Vanilla JS + Telegram Web App SDK, авторизация через `initData` (HMAC-SHA256)
- **API**: Express.js, REST. `/api/webapp/*` под initData, `/api/*` под Bearer JWT
- **БД**: PostgreSQL (Neon free tier)
- **Деплой**: Render (free tier), GitHub `reklamamariairk-ux/maria-crew`
- **Картинки героев**: Cloudinary (unsigned upload preset)

## Структура

```
src/
  api/          — Express routes + middleware
    routes/     — endpoint'ы (employees, prizes, exchanges, ...)
    middleware/ — auth, rate-limit
  bot/          — Telegram-бот
    commands/   — обработчики /start, /coins, /rating, ...
    middleware/ — auth (поиск сотрудника по telegram_id)
    notifications/ — отправка push-сообщений
  scheduler/    — cron-задачи (autoProcessMonth, remindQuiz, ...)
  services/     — бизнес-логика (coin, exchange, rating, ...)
  db/           — pool, migrate, seed
  diagnostics.ts — health-checks
admin/          — Admin Panel (vanilla JS SPA)
webapp/         — Mini App для сотрудников (vanilla JS)
migrations/     — *.sql файлы, выполняются по порядку при старте
```

## Быстрый старт (локально)

### Требования
- Node.js ≥ 18
- PostgreSQL (или подключение к Neon)

### Установка
```bash
git clone https://github.com/reklamamariairk-ux/maria-crew.git
cd maria-crew
npm install
```

### .env

Создай `.env` в корне:

```bash
# Обязательные
BOT_TOKEN=12345:abcdef...                  # из @BotFather
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
ADMIN_SECRET=changeme                      # пароль bootstrap-суперадмина
WEBHOOK_URL=https://crew.145-223-121-47.sslip.io # публичный URL для Telegram webhook
PORT=3000

# Cloudinary (для загрузки фото героев в админке) — опционально
CLOUDINARY_CLOUD_NAME=daswggojd
CLOUDINARY_UPLOAD_PRESET=ml_default

# Опциональные интеграции
CREW_CHANNEL_ID=-1001234567890   # Telegram-канал для дайджестов
GIS2_API_KEY=...                  # для подтягивания рейтинга точек из 2ГИС
RENDER_EXTERNAL_URL=...           # альтернатива WEBHOOK_URL (Render задаёт сам)
```

### Запуск

```bash
# Dev (с auto-reload)
npm run dev

# Build + prod
npm run build
npm start

# Только миграции
npm run migrate

# Тесты (jest, unit-тесты на критичную бизнес-логику)
npm test
npm run test:watch
```

При первом запуске:
1. Применятся все миграции из `migrations/*.sql` по порядку
2. Создастся суперадмин: `username=admin`, пароль = `ADMIN_SECRET`
3. Telegram webhook будет установлен на `WEBHOOK_URL/webhook/<secret>`

## Что куда деплоить

| Компонент | URL/Где |
|---|---|
| Mini App | `WEBHOOK_URL/webapp` (раздаётся сервером) |
| Admin Panel | `WEBHOOK_URL/admin` (basic auth → JWT) |
| API | `WEBHOOK_URL/api/...` |
| Бот webhook | `WEBHOOK_URL/webhook/<random>` (Telegram постит сюда) |

## Роли в админке

| Роль | Права |
|---|---|
| `superadmin` | Всё, плюс управление админами и настройками |
| `editor` («Админище») | Всё, кроме операций с монетами |
| `coin_admin` («Администратор») | Только начисление монет + просмотр сотрудников |

См. `tabAllowed()` в `admin/app.js` — точка истины для UI.

## Поток сотрудника

1. Пишет /start боту → видит кнопку «🚀 Открыть Maria Crew»
2. В Mini App выбирает свою точку → нажимает «Присоединиться»
3. Каждый день: проходит квиз (+5 монет), отмечается (🔥, +1 монета)
4. По итогам месяца: руководитель нажимает «Обработать месяц» → выдаются карточки/премии

## Поток руководителя

1. Открывает Admin Panel → логин (admin / ADMIN_SECRET)
2. **В течение месяца**: bulk-начисляет монеты (чек-лист, отзыв и т.п.) во вкладке «Сотрудники»
3. **В конце месяца**: вносит метрики (тайный покупатель, чек-лист%, план%) → «Обработать месяц»
4. **По заявкам**: подтверждает выдачу/отклоняет в «Заявки»

## Защиты

- **Атомарные транзакции** при обмене (`FOR UPDATE` на сотруднике)
- **UNIQUE-индексы** на `quiz_attempts(emp, question, день)` и `daily_checkins(emp, день)`
- **Rate limit** 10 попыток / 15 мин на `/api/auth/login`
- **Bearer JWT** (HMAC-SHA256) для admin API, **initData HMAC** для Mini App
- **Pool keep-alive** (Neon free tier засыпает) и **Render keep-alive** (free tier тоже)
- **Background fan-out** для уведомлений (rate-limit Telegram)

## Cron-задания

| Время (Иркутск) | Задача |
|---|---|
| Каждую минуту | Neon keep-alive (`SELECT 1`) |
| Каждые 13 мин | Render keep-alive (HTTP `/api/health`) |
| Пн–Сб 09:00 | Утреннее напоминание про квиз в канал |
| Пн–Сб 20:00 | Личное напоминание руководителям про монеты |
| Пятница 18:00 | Еженедельный дайджест в канал |
| Каждый день 10:00 | Дайджест незакрытых заявок руководителям |
| Каждый день 21:00 | Личное напоминание про серию |
| Каждый день 03:30 | Чистка журнала аудита старше 6 месяцев |
| 1-го числа 03:00 | **Авто-обработка прошедшего месяца** (карточки, монеты, уведомления, дайджест) |
| 1-го числа 10:00 | Напоминание руководителям внести метрики |

## Документация по эксплуатации

См. [OPERATIONS.md](OPERATIONS.md) — что делать если БД упала, миграция повисла, бот не отвечает.

## История изменений

См. [CHANGELOG.md](CHANGELOG.md).
