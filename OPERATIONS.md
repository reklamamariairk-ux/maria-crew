# Maria Crew — Operations Runbook

Что делать, когда что-то не работает или нужно вмешаться.

---

## 📞 Точки контакта

- **Бот**: @Mariaprod_bot
- **Repo**: https://github.com/reklamamariairk-ux/reklamamariairk-ux/maria-crew
- **Render dashboard**: https://dashboard.render.com → service `maria-crew`
- **Neon dashboard**: https://console.neon.tech (БД)
- **Cloudinary**: dashboard.cloudinary.com (для фото героев)
- **GitHub Token**: settings → Developer settings → Personal access tokens (если нужен push)

---

## 🚨 Критические сценарии

### Бот не отвечает на `/start`

**Шаги диагностики:**

1. Открой https://maria-crew.onrender.com/api/health → должно быть `{ ok: true }`
   - Если 503 / timeout → Render задеплоил битую сборку или процесс упал
   - Если 200 → проблема в Telegram webhook
2. Проверь Render Logs → `dashboard.render.com → service → Logs`
   - `[bot] Webhook setup` — должно быть в логах при старте
   - Ошибки запросов к БД?
3. Проверь webhook руками:
   ```bash
   curl https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
   ```
   Должно показать `url: "https://maria-crew.onrender.com/webhook/<secret>"` и `pending_update_count: 0`.

**Если webhook сбит:**

```bash
# Удалить старый
curl -X POST https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook

# Перезапустить сервис на Render → Manual Deploy → выберет новый webhook автоматически
```

### БД заснула / медленные ответы

Neon free tier засыпает через 60-300 секунд бездействия. Cron `* * * * *` (каждую минуту) делает `SELECT 1` — должен держать активным. Если всё-таки заснул:

- Первый запрос будет долгим (5-15 сек) — это **нормальное** просыпание
- Если БД долго не просыпается → Neon dashboard → Compute → Resume

### Миграция упала на старте

Симптомы: процесс не запускается, в логе `Migration failed: ...`.

**Что делать:**

1. Открой Render Logs → найди имя файла миграции (`027_quiz_attempt_unique.sql` и т.п.)
2. Если миграция уже частично применилась — она в таблице `schema_migrations`. Проверь:
   ```sql
   SELECT * FROM schema_migrations ORDER BY filename;
   ```
3. Если запись есть, но тело не выполнилось → удали запись:
   ```sql
   DELETE FROM schema_migrations WHERE filename = '027_quiz_attempt_unique.sql';
   ```
4. Поправь файл миграции в репо (например, добавь `IF NOT EXISTS`), запушь
5. Render передеплоит → миграция применится снова

**Откатить миграцию вручную:**

```bash
# Подключись к Neon через psql или Neon dashboard SQL editor
psql $DATABASE_URL

# Например, отменить добавленный индекс
DROP INDEX IF EXISTS uq_quiz_attempts_emp_q_irkutsk_day;
DELETE FROM schema_migrations WHERE filename = '027_quiz_attempt_unique.sql';
```

### Квиз даёт ошибку «Resource not accessible»

Скорее всего в БД есть транзакции с категорией, которой нет в `quiz_questions.category`. Проверить:

```sql
SELECT DISTINCT category FROM quiz_questions;
```

Должны быть только: `product`, `service`, `crew`. Если есть другие — отредактируй вопрос в админке (вкладка «Квиз»).

### Сотруднику не пришла карточка после «Обработать месяц»

1. Проверь, что сотрудник `is_active = true`:
   ```sql
   SELECT id, name, is_active FROM employees WHERE name LIKE '%Иванов%';
   ```
2. Проверь метрики за месяц:
   ```sql
   SELECT * FROM monthly_metrics
   WHERE employee_id = 42 AND year = 2026 AND month = 5;
   ```
   Должны быть заполнены `mystery_shopper_score`, `checklist_percent` и т.д.
3. Проверь карточки за месяц:
   ```sql
   SELECT * FROM employee_cards
   WHERE employee_id = 42 AND year = 2026 AND month = 5;
   ```
4. Перезапустить обработку — в админке «Метрики» → выбрать точку → «Обработать месяц». Идемпотентно.

### Обмен на приз: списались карточки, но приз не выдан

```sql
-- Найти заявку
SELECT * FROM store_exchanges WHERE employee_id = 42 ORDER BY created_at DESC LIMIT 5;

-- Если status='pending' — выдать через UI или
UPDATE store_exchanges SET status = 'fulfilled', processed_at = NOW() WHERE id = 123;

-- Если хочется откатить — поставить rejected, и сервер вернёт ресурсы
-- (проверь логику processExchange — он возвращает только при PUT через API)
```

**Важно:** для возврата карточек/монет используй админку, не SQL. Иначе пропустишь возвратные транзакции.

---

## 🔧 Типовые операции

### Добавить нового админа

В Mini App это не делается. Через UI:
- Логин под `superadmin`
- → «Доступы» → «Добавить пользователя»

Через SQL (только если UI недоступен):
```sql
-- Bcrypt не установлен на проде, используй ADMIN_SECRET fallback:
-- 1. Проще: меняешь ADMIN_SECRET в Render env, перезапускаешь — система пересоздаст admin user
-- 2. Через Node REPL:
node -e "
const { hashPassword } = require('./dist/services/adminAuth.service');
console.log(hashPassword('newpassword'));
"
-- Получишь scrypt-hash, затем:
INSERT INTO admin_users (username, password_hash, role, must_change_password)
VALUES ('ivan', 'salt:hash', 'editor', true);
```

### Сбросить пароль админа

В UI: «Доступы» → 🔑 у нужного пользователя → ввести новый.
Юзер при следующем логине будет вынужден сменить (флаг `must_change_password`).

Через SQL (если потерян доступ совсем):
```sql
-- Сбросить пароль на ADMIN_SECRET (тот, что в env)
UPDATE admin_users SET password_hash = (SELECT password_hash FROM admin_users WHERE username='admin'),
                       must_change_password = true
WHERE username = 'lost_user';
```

### Обновить картинки героев

Только через админку: «Герои» → 📤 кнопка загрузки на каждом ряду. Загрузится в Cloudinary, URL сохранится в `heroes.image_url`.

Если Cloudinary упал — можно вписать прямую ссылку в текстовое поле, тоже сохранится.

### Поменять размер награды (монеты за квиз и т.п.)

Файл `src/services/coin.service.ts`, константа `COIN_AMOUNTS`. После изменения:
1. Закоммить и запушить
2. Также обнови тексты в `webapp/main.js`, `bot/commands/coins.ts`, `scheduler/jobs/remindQuiz.ts` — иначе обещания и реальность разойдутся

Награды за «Лучший сотрудник» и «Лучшая точка» — настраиваются **через админку** в «Настройки» (без правки кода).

### Добавить вопрос в квиз

Через UI: «Квиз» → «Добавить вопрос» → 4 варианта + указать правильный (А/Б/В/Г).

Не забудь про категорию (`product` / `service` / `crew`) — иначе в Mini App не будет фильтра по теме.

### Добавить новую точку

UI: «Точки» → «Добавить». 

Если у точки есть страница в 2ГИС, впиши `gis2_id` (15-значный) — система сможет автоматически подтягивать средний рейтинг при обработке месяца. См. `src/services/gis2.service.ts`.

### Перевод сотрудника на другую точку

UI: «Сотрудники» → выпадающий список «Точка» в строке сотрудника. Подтверждение → перевод. История карточек/монет/метрик не теряется — всё привязано к `employee_id`.

### Ребут (если совсем плохо)

```bash
# Render dashboard → Manual Deploy → Deploy latest commit
# Или: revert в git → push → автодеплой
git revert <bad-commit>
git push
```

---

## 📊 Как следить, что всё работает

### Health-checks

- `GET https://maria-crew.onrender.com/api/health` — должно быть `{ ok: true, ... }`
- В админке → «Дашборд» — engagement chart за 30 дней. Если хвост обнулился — сотрудники перестали отмечаться (бот не отвечает?)

### Логи

Render → service → Logs (real-time). Ищи:
- `[scheduler]` — cron сработал
- `[auto-process] done: N stores processed` — 1-го числа в 03:00 должно быть
- `[notify]` — push'и
- `[bot] Ошибка update#...` — ошибка обработчика бота
- `[migrations]` — при старте

### Аудит

Все важные действия логируются в `admin_audit_log`. UI: «Журнал» (только super/editor).

```sql
-- Последние 50 действий
SELECT created_at, action, performed_by, details
FROM admin_audit_log
ORDER BY created_at DESC LIMIT 50;
```

Хранится 6 месяцев (cron `auditRetention` каждую ночь чистит старше).

### Метрики Telegram

```bash
# Сколько у бота подписчиков (только админу)
curl https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo

# Информация про бота
curl https://api.telegram.org/bot<BOT_TOKEN>/getMe
```

---

## 🆘 Что точно НЕ делать

- ❌ Не дёргать `DROP TABLE` на проде
- ❌ Не менять `ADMIN_SECRET` без необходимости — все токены сессий админов сразу инвалидируются (HMAC использует этот секрет)
- ❌ Не push'ить с `--no-verify` или `--force` на main
- ❌ Не править таблицу `schema_migrations` руками без понимания, что делаешь
- ❌ Не отключать cron Neon keep-alive — БД заснёт, первые запросы будут падать
- ❌ Не делиться `BOT_TOKEN` — он даёт полный контроль над ботом
- ❌ Не хранить пароли админов в plaintext в `.env` — только `ADMIN_SECRET` для bootstrap

---

## 📅 Регулярные проверки

| Что | Как часто | Где |
|---|---|---|
| Cron `autoProcessMonth` отработал | 1-го числа каждого месяца | Render Logs → найди `[auto-process] done` после 03:00 |
| Engagement chart не пустой | Раз в неделю | Admin → Дашборд |
| Заявки на призы обрабатываются | Каждый день | Admin → Заявки (или приходит дайджест в 10:00) |
| Размер БД < 0.5 GB | Раз в месяц | Neon dashboard → Storage |
| Render bandwidth не превышен | Раз в месяц | Render dashboard → Bandwidth |

Free tier'ы Neon и Render имеют лимиты — если превысишь, сервис может уснуть.

---

## 🐛 Известные ограничения

- **Render free tier** засыпает через 15 мин без трафика. Cron keep-alive (каждые 13 мин) держит активным, но если cron на самом сервере не сработал — первый запрос займёт 30+ секунд (cold start).
- **Neon free tier** — то же самое, керп-алайв каждую минуту.
- **Telegram limits**: 30 msg/sec на бота. `sendBroadcast` шлёт батчами по 25 с паузой 1.1с — соответствует.
- **Mini App initData TTL**: ~24 часа. После этого пользователь должен переоткрыть.
- **Pool size** в БД: 5 connections. При взрывном росте нагрузки могут быть очереди.
- **История транзакций** в Mini App: последние 30. История обменов: последние 30. Журнал аудита: 6 месяцев.

---

## ⚙️ Переменные окружения

| Переменная | Обязательно | Описание |
|---|---|---|
| `BOT_TOKEN` | ✅ | Токен бота из @BotFather |
| `DATABASE_URL` | ✅ | Neon connection string с `?sslmode=require` |
| `ADMIN_SECRET` | ✅ | Пароль bootstrap-суперадмина (логин `admin`) |
| `WEBHOOK_URL` | ✅ | Публичный URL сервера для Telegram webhook |
| `PORT` | ✅ | По умолчанию 3000 |
| `OWNER_TELEGRAM_ID` | ⚪ | Telegram-ID владельца — для критических алертов |
| `CLOUDINARY_CLOUD_NAME` | ⚪ | Для загрузки фото героев |
| `CLOUDINARY_UPLOAD_PRESET` | ⚪ | Unsigned preset (mh_default или ml_default) |
| `CREW_CHANNEL_ID` | ⚪ | Telegram-канал для дайджестов («-1001234...») |
| `GIS2_API_KEY` | ⚪ | Для подтягивания рейтинга точек из 2ГИС |
| `RENDER_EXTERNAL_URL` | ⚪ | Альтернатива WEBHOOK_URL (Render задаёт сам) |

---

## 🚨 Настройка мониторинга

### Telegram-алерты

Установи `OWNER_TELEGRAM_ID` (своё число — узнать через @userinfobot). После этого в Telegram приходят push'и при:
- Падении `autoProcessMonth` (ежемесячная обработка)
- Падении `remindMetrics` (напоминание метрик)
- Любой unhandled-ошибке в боте (с throttle 1 час по тексту, чтобы не заспамить)

### UptimeRobot (бесплатно)

1. Регистрируйся на https://uptimerobot.com
2. Добавь монитор:
   - Type: **HTTP(s)**
   - URL: `https://maria-crew.onrender.com/api/health/detailed`
   - Interval: **5 minutes**
   - Алерты: Telegram (через @UptimeRobotBot или Email)

При проблемах endpoint вернёт `503` — UptimeRobot пришлёт уведомление.

### Что проверяет `/api/health/detailed`

- **БД отвечает** — `SELECT 1` отрабатывает
- **Cron'ы успешны** — последний запуск каждого без ошибки
- **Нет свежих ошибок бота** — в последние 5 минут чист

Если что-то не так → 503 + детали в JSON. Можно дёргать руками для диагностики.

### Просмотр истории cron

```bash
curl https://maria-crew.onrender.com/api/health/detailed | jq '.checks.crons'
```

Покажет JSON со всеми cron'ами, временем последнего запуска и количеством успехов/ошибок с момента старта сервиса.

---

**Последнее обновление: май 2026**
