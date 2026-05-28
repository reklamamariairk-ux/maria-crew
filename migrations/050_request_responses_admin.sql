-- 050: Отслеживаем какой именно admin_user написал сообщение менеджера.
--
-- В chat-mode (049) sender_type='manager' писалось без указания кто
-- из менеджеров. В UI отображалось общее «руководитель», без имени.
-- Теперь сохраняем admin_user_id и показываем username.

ALTER TABLE request_responses
  ADD COLUMN IF NOT EXISTS admin_user_id INTEGER REFERENCES admin_users(id);
