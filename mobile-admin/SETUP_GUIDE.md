# «Мария · Админ» — мобильное приложение админки

Нативная обёртка (Capacitor) **админ-панели** maria-crew для руководителей.
Отдельное приложение от `mobile/` (то — клиент для сотрудников).

- **appId / Bundle ID:** `ru.mariairk.crew.admin`
- **Что внутри:** приложение открывает живую админку `https://crew.145-223-121-47.sslip.io/`
  (LIVE-режим). Правки админки на сервере видны сразу, без переустановки приложения.
- **Распространение:** НЕ публичный App Store (Apple 3.2: приложение одной компании).
  iOS → **Unlisted App Distribution** или **TestFlight**; Android → **closed track** / **RuStore**.

## Статус готовности

| Готово | Осталось (твои руки) |
|---|---|
| ✅ Capacitor-проект, конфиг, бренд-иконки/сплэш | Apple Developer аккаунт ($99/год) |
| ✅ Android-платформа + **debug APK собран локально** | Codemagic-аккаунт + Apple-сертификаты |
| ✅ codemagic.yaml (облачная iOS+Android сборка) | Создать приложение в App Store Connect (Unlisted) |
| ✅ Совместимо с CSP сервера (same-origin, cloudinary в allow) | Собрать .ipa в облаке → TestFlight/Unlisted |

**Локальный Mac не нужен** — iOS собирается в облаке (Codemagic, macOS-раннер).

---

## Android — можно прямо сейчас

Debug APK уже собирается локально:
```
cd mobile-admin/android && ./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk  (поставить на телефон, проверить)
```

Release (подписанный, для RuStore / Google Play closed track):
```
# положить keystore (можно тот же, что mobile/maria-crew.keystore) и signing-конфиг,
# затем:
cd mobile-admin/android && ./gradlew bundleRelease   # → .aab для Google Play
# или assembleRelease → .apk для RuStore / прямой раздачи
```

## iOS — через Codemagic (облако)

1. **Apple Developer Program** — оформить на доверенное лицо (физлицо подходит; карта КР Bakai, как для maria-crew). $99/год.
2. **App Store Connect** → новое приложение, Bundle ID `ru.mariairk.crew.admin`,
   Distribution Method = **Unlisted** (либо просто заливать в TestFlight внутренним тестерам).
3. **Codemagic** (codemagic.io, бесплатный тариф хватает):
   - подключить репозиторий maria-crew, рабочая папка `mobile-admin/`;
   - Teams → Integrations → **App Store Connect**: создать API-ключ (Issuer ID + Key ID + .p8),
     назвать `MariaAdminKey` (совпадает с `integrations.app_store_connect` в codemagic.yaml);
   - запустить workflow **ios-admin** → соберётся `.ipa` и уедет в **TestFlight**
     (группа «Руководители»); оттуда — на устройства руководителей.
4. Пригласить руководителей в TestFlight (по email) — они ставят приложение из TestFlight-ссылки.

## Против отклонения Apple 4.2 («обёртка сайта»)

Уже заложено: бренд-иконки, сплэш, StatusBar/SplashScreen/App-плагины, статус
«внутренний инструмент компании». Для Unlisted/TestFlight этого обычно достаточно.
В App Review Notes указать: «Internal admin tool for Maria confectionery managers,
distributed privately (not public). Demo login предоставлен».
Приложить демо-доступ для ревьюера (тестовый админ-логин).

**Если всё же зарежут по 4.2 (fallback — офлайн-бандл):**
- в `capacitor.config.json` убрать `server.url`, поставить `webDir` на копию `admin/`;
- в `admin/app.js` завести `const API_BASE = location.protocol==='capacitor:'||location.protocol==='https:'&&location.hostname==='localhost' ? 'https://crew.145-223-121-47.sslip.io' : ''`
  и заменить `fetch(\`/api${path}\`)` → `fetch(\`${API_BASE}/api${path}\`)` (и логин/экспорт/бэкап);
- добавить `connect-src https://crew.145-223-121-47.sslip.io` в CSP сервера
  (в Capacitor-origin запросы станут cross-origin);
- тогда UI локальный (app-like), API ходит на сервер — надёжнее проходит ревью,
  но каждое обновление админки требует пересборки приложения.

## Обновление приложения при смене домена сервера
Поменять `server.url` и `allowNavigation` в `capacitor.config.json`, пересобрать.
