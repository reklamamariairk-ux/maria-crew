# Maria Crew Mobile (Capacitor wrapper)

Нативное приложение для iOS / Android, обёрнутое вокруг существующего `webapp/`.
Один кодовый набор UI, две платформы.

## Что внутри

- `capacitor.config.ts` — конфиг (appId, webDir, плагины)
- `package.json` — зависимости Capacitor и плагинов
- `assets/` (создать вручную) — иконки 1024×1024 и сплеши для генерации

## Что нужно установить разово

### macOS (для iOS-сборки)
- Xcode 15+ из App Store
- CocoaPods: `sudo gem install cocoapods`
- Apple Developer аккаунт ($99/год) для Distribution

### Windows / Linux / macOS (для Android-сборки)
- [Android Studio](https://developer.android.com/studio) (с Android SDK)
- Java 17+ (приходит с Android Studio)
- Google Play Console аккаунт ($25 разово) для Distribution

## Первый билд

```bash
cd mobile
npm install
npx cap add android        # создаёт mobile/android/ — нативный проект
npx cap add ios            # только на macOS — создаёт mobile/ios/

# Иконки и сплеши: положи 1024×1024 PNG в mobile/assets/icon.png
# и 2732×2732 в mobile/assets/splash.png, потом:
npm run icons

# Скопировать webapp/ в native-bundle
npm run sync

# Android: открыть в Android Studio и собрать
npm run open:android

# iOS: открыть в Xcode (только на macOS)
npm run open:ios
```

## Push-уведомления (FCM)

Backend (`src/services/push.service.ts`) уже готов принимать токены через
`POST /api/v1/devices` и отправлять (когда раскомментирован FCM-блок).

Нужно:
1. Создать Firebase project (бесплатно): https://console.firebase.google.com/
2. Добавить Android-приложение `ru.mariairk.crew`, скачать `google-services.json`
   → положить в `mobile/android/app/google-services.json`
3. Добавить iOS-приложение `ru.mariairk.crew`, скачать `GoogleService-Info.plist`
   → положить в `mobile/ios/App/App/GoogleService-Info.plist`
4. Service Account для серверной отправки: Project Settings → Service accounts
   → Generate new private key → JSON
5. На Render выставить env `FIREBASE_SERVICE_ACCOUNT_JSON` = содержимое JSON одной строкой
6. Раскомментировать FCM-блок в `src/services/push.service.ts` и
   `npm i firebase-admin` в корне

В `webapp/main.js` после успешного login:
```js
import { PushNotifications } from '@capacitor/push-notifications';
PushNotifications.requestPermissions().then(perm => {
  if (perm.receive === 'granted') PushNotifications.register();
});
PushNotifications.addListener('registration', token => {
  fetch('/api/v1/devices', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + mobileToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token.value, platform: Capacitor.getPlatform() }),
  });
});
```
(этот код будет добавлен после установки Capacitor — пока не работает, поскольку плагин не подгружен).

## Подача в App Store / Play Store

### Apple
1. Создать app в [App Store Connect](https://appstoreconnect.apple.com/)
2. Bundle ID: `ru.mariairk.crew` (должен совпадать с capacitor.config.ts)
3. Скриншоты для всех размеров (генерируется через симулятор Xcode)
4. Privacy Policy URL — обязательно (см. PRIVACY.md в корне репо)
5. Кнопка «Удалить аккаунт» — уже реализована (`DELETE /api/v1/account`),
   подключена в UI настроек webapp
6. Архив через Xcode → Validate → Distribute → App Store

### Google Play
1. Создать app в [Play Console](https://play.google.com/console/)
2. Подписать ключ: `keytool -genkey -v -keystore release.keystore -alias maria-crew ...`
3. `cd mobile/android && ./gradlew bundleRelease` → AAB-файл в `app/build/outputs/bundle/release/`
4. Загрузить AAB через Play Console
5. Заполнить контент-рейтинг, категорию, скриншоты, описание

## Live-разработка

Чтобы во время разработки видеть изменения webapp/ без re-sync:
```ts
// в capacitor.config.ts раскомментировать:
server: {
  url: 'https://maria-crew.onrender.com/webapp',
  cleartext: false,
}
```
Тогда WebView грузит ассеты с прода, а нативные плагины (push, прочее) работают локально.
