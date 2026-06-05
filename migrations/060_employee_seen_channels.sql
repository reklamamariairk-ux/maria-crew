-- 060: Откуда заходит сотрудник — Telegram Mini App или мобильное приложение (APK).
--
-- Канал определяется способом авторизации: initData = Telegram, Bearer JWT = APK.
-- last_seen_at остаётся общим «когда был» (его пишут оба канала), новые колонки
-- говорят КАКИМ каналом пользовались и когда в последний раз. Админка показывает
-- бейджи в таблице «Сотрудники».

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS last_seen_tg_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_app_at TIMESTAMPTZ;
