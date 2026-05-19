# Maria Crew — пошаговый запуск мобильного приложения

Гайд от нуля до приложения в Google Play и App Store.
Считаем, что ты на Windows. iOS-часть отдельно — там нужен Mac или Codemagic.

---

## Этап 1 — Установить программы (1-2 часа)

### 1.1. Node.js
1. Открой https://nodejs.org/
2. Скачай **LTS** версию (зелёная кнопка слева)
3. Запусти `.msi`-файл, жми Next-Next-Install
4. Проверь: открой PowerShell → `node -v` → должно показать `v20.x.x` или выше

### 1.2. Git (если нет)
1. https://git-scm.com/download/win → скачается автоматически
2. Установка: все дефолты, кроме «Default editor» — выбери **Notepad** (самое простое)
3. Проверка: `git --version`

### 1.3. Android Studio
1. https://developer.android.com/studio → большая зелёная кнопка **Download Android Studio**
2. Принимай условия → ~1 ГБ
3. Запусти установщик → **Standard** установка → жми Next до конца
4. После запуска Android Studio сам докачает SDK + эмулятор (~3-5 ГБ, 30-60 минут)
5. Когда закончит — на главном экране должна быть кнопка «New Project»

### 1.4. Java (придёт с Android Studio автоматически)
Проверка: в PowerShell `java -version` → должно показать что-то вроде `openjdk version "17.0.x"`

Если не показывает — открой Android Studio → File → Project Structure → SDK Location → скопируй путь к JDK → добавь в системную переменную `JAVA_HOME`.

---

## Этап 2 — Создать Firebase project (15 минут)

Firebase нужен для push-уведомлений на iOS и Android.

### 2.1. Создать проект
1. Открой https://console.firebase.google.com/
2. Войди под Google-аккаунтом (`bbf2018.ru@gmail.com`)
3. Жми **«Создать проект»** / **«Add project»**
4. Имя: `maria-crew` → Continue
5. Google Analytics: выключи (нам не нужно) → Create project
6. Подожди 30 секунд → Continue

### 2.2. Добавить Android-приложение
1. На главной Firebase project жми иконку **Android** (зелёный робот)
2. Поля:
   - **Package name:** `ru.mariairk.crew` (важно — в точности такой же в `mobile/capacitor.config.ts`)
   - **App nickname:** `Maria Crew Android`
   - **SHA-1:** пока пропусти (понадобится при подписи)
3. Жми **Register app**
4. Скачай **`google-services.json`** — положи в папку `C:\Users\user\maria-crew\mobile\android\app\` (создашь после `cap add android` — пока сохрани файл рядом)
5. Остальные шаги «Add Firebase SDK» и т.д. жми **Next-Next-Continue to Console** — мы добавим SDK через Capacitor плагин.

### 2.3. Добавить iOS-приложение (даже если пока нет Mac)
1. На главной Firebase project жми иконку **iOS** (Apple)
2. Поля:
   - **Bundle ID:** `ru.mariairk.crew`
   - **App nickname:** `Maria Crew iOS`
3. Скачай **`GoogleService-Info.plist`** — пригодится позже
4. Next-Next-Continue.

### 2.4. Получить серверный ключ для отправки push с бэка
1. В Firebase Console: ⚙️ (шестерёнка слева сверху) → **Project settings**
2. Вкладка **Service accounts**
3. Жми **Generate new private key** → скачается JSON-файл
4. **ВАЖНО:** этот файл — секрет. Никому не показывай, не коммить в Git.
5. Открой файл в блокноте → выдели всё (Ctrl+A) → скопируй (Ctrl+C)

### 2.5. Прописать ключ в Render
1. https://dashboard.render.com → сервис **maria-crew** → **Environment**
2. **Add Environment Variable**
3. Key: `FIREBASE_SERVICE_ACCOUNT_JSON`
4. Value: вставь весь скопированный JSON одной строкой (Render умеет multiline)
5. **Save Changes** → сервис автоматически перезапустится
6. Push-уведомления заработают, как только в коде раскомментируется FCM-блок (см. `src/services/push.service.ts` — TODO с инструкцией)

---

## Этап 3 — Зарегистрировать Google Play Console (1 час, $25)

Это разовый платёж, после которого можно публиковать сколько угодно приложений.

### 3.1. Регистрация
1. Открой https://play.google.com/console/signup
2. Войди под Google-аккаунтом
3. Тип аккаунта: **Organization** (юр. лицо «Мария»)
4. Заполни данные компании
5. Оплати **$25** (нужна Visa/MasterCard, на российские сейчас может не пройти — варианты: карта Wise, или Tinkoff Black Premium с межнар. транзакциями, или попросить кого-то с зарубежной картой)
6. Подожди подтверждения (24-48 часов)

### 3.2. Создать приложение в Console
1. После одобрения — войди в https://play.google.com/console
2. **Create app**
3. Поля:
   - **App name:** `Maria Crew`
   - **Default language:** Russian
   - **App or game:** App
   - **Free or paid:** Free
   - Согласись с правилами → **Create app**

### 3.3. Заполнить минимально для первого внутреннего теста
В левом меню — список разделов с пометками «To do». Заполни:
- **App access** — «All functionality is available without special access» (если так) или «All or some functionality is restricted» с описанием логина по PIN
- **Ads** — нет
- **Content rating** — пройди опросник, выбери Business
- **Target audience** — 18+ (внутренний инструмент)
- **News app** — нет
- **Data safety** — заполни (см. твой PRIVACY.md)
- **Privacy Policy URL** — нужен URL. Сначала опубликуй PRIVACY.md как страницу на сайте https://maria-irk.ru/privacy

---

## Этап 4 — Apple Developer (опционально, $99/год)

Можно пропустить и сделать только Android. Если решишь делать iOS:

1. https://developer.apple.com/programs/enroll/
2. Нужна оплата $99 ежегодно (карта Visa/MC, проблема с РФ-картами та же)
3. После одобрения (24 часа): https://appstoreconnect.apple.com/ → **My Apps** → **+** → **New App**
4. Bundle ID: `ru.mariairk.crew`
5. SKU: `maria-crew` (любой уникальный)
6. Подробнее заполнишь после первой сборки.

---

## Этап 5 — Первая сборка Android (30 минут)

Теперь самое интересное.

### 5.1. Установить Capacitor
В PowerShell:
```powershell
cd C:\Users\user\maria-crew\mobile
npm install
```
~5 минут (поставит ~200 МБ зависимостей)

### 5.2. Создать Android-проект
```powershell
npx cap add android
```
Это создаст папку `mobile/android/` с нативным проектом.

### 5.3. Положить google-services.json
Возьми скачанный на этапе 2.2 файл и положи сюда:
```
C:\Users\user\maria-crew\mobile\android\app\google-services.json
```

### 5.4. Синхронизировать webapp в native bundle
```powershell
npm run sync
```

### 5.5. Открыть в Android Studio
```powershell
npm run open:android
```

Android Studio откроет проект. Подожди 2-3 минуты пока он индексирует Gradle.

### 5.6. Запустить на эмуляторе (тест)
1. В верхнем тулбаре Android Studio: справа от кнопки Run (▶️) — выбор устройства
2. **Device Manager** → **Create device** → **Pixel 6** → Next → System Image **Tiramisu** → Download → Finish → Create
3. Запусти эмулятор (▶️ рядом с Pixel 6)
4. Когда эмулятор поднимется — жми зелёную **Run ▶️** в Android Studio
5. Через 30 секунд приложение запустится на эмуляторе → должен показаться login-экран Maria Crew

### 5.7. Проверить login flow
1. В эмуляторе введи свой телефон (тот, что в БД)
2. Жми «Получить код»
3. Открой Telegram-бот @Mariaprod_bot — должен прийти 6-значный код
4. Введи его в эмуляторе → должно войти и показать твой UI

✅ Если всё работает — поздравляю, у тебя есть первый билд!

---

## Этап 6 — Иконки и сплеш (30 минут)

Capacitor умеет генерировать все размеры из 1 PNG.

### 6.1. Подготовить картинки
Тебе нужны 2 файла:
- **icon.png** — 1024×1024, без прозрачности, **БЕЗ закруглённых углов** (системы сами скруглят)
- **splash.png** — 2732×2732, центральный логотип в круге диаметром ~1200px, фон однотонный

Самый простой путь: попроси дизайнера или сделай в Canva (https://canva.com) бесплатно.

Положи файлы в `mobile/assets/icon.png` и `mobile/assets/splash.png`.

### 6.2. Сгенерировать все размеры
```powershell
cd C:\Users\user\maria-crew\mobile
npm run icons
```
Capacitor создаст ~30 версий разных размеров для Android и iOS.

### 6.3. Пере-синк
```powershell
npm run sync
```

---

## Этап 7 — Подписать APK/AAB для Play Store (45 минут)

Google Play требует подписанный AAB (Android App Bundle).

### 7.1. Создать keystore (один раз навсегда)
```powershell
cd C:\Users\user\maria-crew\mobile
keytool -genkey -v -keystore maria-crew.keystore -alias maria-crew -keyalg RSA -keysize 2048 -validity 10000
```
Ответь на вопросы:
- Пароль keystore: придумай сложный, **запиши в надёжное место** (1Password, Bitwarden — без него потеряешь возможность обновлять приложение)
- Имя/фамилия: `ООО Мария`
- Организация: `Maria Bakery`
- Город: `Иркутск`
- Регион: `IR`
- Страна: `RU`

Файл `maria-crew.keystore` появится в `mobile/`. **Никогда не коммить его в Git** (уже в .gitignore).

### 7.2. Прописать в gradle
Открой `mobile/android/app/build.gradle` → найди блок `android { ... }` → добавь внутри:
```groovy
    signingConfigs {
        release {
            storeFile file('../../maria-crew.keystore')
            storePassword 'ТВОЙ_ПАРОЛЬ'
            keyAlias 'maria-crew'
            keyPassword 'ТВОЙ_ПАРОЛЬ'
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
        }
    }
```

### 7.3. Собрать AAB
В Android Studio: **Build → Generate Signed Bundle / APK → Android App Bundle → Next**.
Или в терминале:
```powershell
cd mobile/android
./gradlew bundleRelease
```

Файл появится: `mobile/android/app/build/outputs/bundle/release/app-release.aab`

### 7.4. Загрузить в Play Console
1. https://play.google.com/console → твоё приложение → **Production** в левом меню
2. **Create new release**
3. **Upload** → выбери `app-release.aab`
4. Заполни **Release notes** на русском: «Первый релиз»
5. **Save** → **Review release** → **Start rollout to Production**

Модерация занимает 1-7 дней.

**Совет:** для первого раза используй **Internal testing** (быстрее, до 100 тестировщиков), потом перенесёшь в Production. Это в том же меню, под Production.

---

## Этап 8 — iOS через Codemagic (без Mac, ~30 минут)

### 8.1. Регистрация
1. https://codemagic.io/signup → войди через GitHub
2. Дай доступ к репозиторию `maria-crew`
3. **Create app** → выбери `maria-crew` → **iOS App with Capacitor**

### 8.2. Apple credentials
В Codemagic нужны:
1. **Apple Developer Program membership** (см. этап 4)
2. **App Store Connect API key:**
   - https://appstoreconnect.apple.com/access/integrations/api
   - Generate API Key → Admin role
   - Скачай `.p8` файл (можно один раз!)
3. В Codemagic: **Teams → Integrations → Apple Developer Portal → Add API key**

### 8.3. Настроить workflow
В корне `mobile/` создай `codemagic.yaml` (могу подготовить шаблон по запросу).

### 8.4. Запустить билд
В Codemagic жми **Start new build** → выбирает `master` ветку → 15-30 минут → готов `.ipa` файл.

### 8.5. Опубликовать в App Store
Codemagic умеет автоматически загружать в TestFlight (бета) и потом в App Store. Один раз настроишь — потом каждый push в master = новая версия.

---

## Чеклист готовности

Перед выпуском первой версии. Обновлено 2026-05-12.

**Уже сделано:**
- [x] Node.js, Git, Android Studio установлены (`mobile/node_modules/` есть)
- [x] Capacitor wrapper настроен (`mobile/capacitor.config.ts`, `appId: ru.mariairk.crew`)
- [x] Android-проект создан (`npx cap add android` выполнен)
- [x] Иконка + сплеш сгенерированы (новый дизайн — стилизованная М)
- [x] `@capacitor/push-notifications` плагин подключён
- [x] Privacy Policy опубликована: **https://crew.145-223-121-47.sslip.io/privacy**
- [x] Логин в мобильном приложении (email + телефон) реализован

**Осталось:**
- [ ] Создан Firebase project, скачаны `google-services.json` (Android) и `GoogleService-Info.plist` (iOS)
- [ ] `FIREBASE_SERVICE_ACCOUNT_JSON` прописан в Render
- [ ] Создан keystore для подписи Android (см. `mobile/scripts/create-keystore.ps1`)
- [ ] Signing config прописан в `mobile/android/app/build.gradle` + `mobile/android/keystore.properties`
- [ ] Зарегистрирован Google Play Console ($25 единоразово)
- [ ] Первый AAB протестирован на реальном устройстве
- [ ] AAB загружен в Internal Testing в Play Console
- [ ] (опц.) Зарегистрирован Apple Developer ($99/год)
- [ ] (опц.) iOS-сборка через Codemagic

**Privacy Policy URL для маркетов:**
- App Store Connect → App Information → Privacy Policy URL → `https://crew.145-223-121-47.sslip.io/privacy`
- Play Console → Main store listing → Privacy Policy → тот же URL

---

## Где попросить помощь

- Capacitor Discord: https://discord.com/invite/UPYYRhtyzp
- Stack Overflow: тег `capacitor`
- Документация: https://capacitorjs.com/docs

Если что-то непонятно или сломалось — пиши Claude в этом проекте, разберёмся.
