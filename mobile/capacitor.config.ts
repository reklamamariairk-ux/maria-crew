import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor-конфигурация мобильного приложения Maria Crew.
 *
 * Стратегия: wrapping существующего webapp/ — никаких изменений в UI-коде.
 * Capacitor создаёт нативный shell (Activity для Android, ViewController для iOS),
 * внутри запускает WebView с указанным `webDir`. Все вызовы к /api/* идут на
 * server (через `server.url` ниже).
 *
 * Push-уведомления: @capacitor/push-notifications — обёртка над FCM (Android)
 * и APNs (iOS). При первом запуске запросит разрешение, получит токен,
 * мы его POSTaем на /api/v1/devices.
 *
 * Дальнейшие шаги:
 *   1. cd mobile && npm install
 *   2. npx cap add android
 *   3. npx cap add ios       (только на macOS)
 *   4. npm run sync
 *   5. npm run open:android  → собрать в Android Studio
 *   6. npm run open:ios      → собрать в Xcode
 */
const config: CapacitorConfig = {
  appId: 'ru.mariairk.crew',
  appName: 'Maria Crew',
  // Указываем родительский webapp/ — Capacitor скопирует содержимое
  // в native-bundle при `cap sync`. Альтернатива: `server.url` (live-режим).
  webDir: '../webapp',

  server: {
    // Production: бэк живёт на Render, фронт-ассеты бандлятся в приложении.
    // Когда нужно тестировать живой UI — раскомментировать `url` ниже:
    // url: 'https://maria-crew.onrender.com/webapp',
    androidScheme: 'https',
    cleartext: false,
    // Whitelist для cross-origin fetch — иначе WebView может блочить запросы
    allowNavigation: ['maria-crew.onrender.com', '*.onrender.com'],
  },

  plugins: {
    SplashScreen: {
      // Минимум — 200мс. Дальше JS вызовет SplashScreen.hide() как только
      // покажет UI из кеша (instant). Если кеша нет — splash будет до 2 сек,
      // потом всё равно скрывается, а юзер видит loading screen с прогрессом.
      launchShowDuration: 200,
      launchAutoHide: true,
      backgroundColor: '#e8639b',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#d4920a',
    },
  },

  ios: {
    contentInset: 'always',
  },

  android: {
    backgroundColor: '#ffffff',
    allowMixedContent: false,
    captureInput: true,
  },
};

export default config;
