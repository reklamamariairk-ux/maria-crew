// Одноразовый CLI-скрипт сброса пароля суперадмина «admin».
// Запуск:  npm run reset-admin-password -- 'НовыйПароль'
// Скрипт ничего не активирует автоматически — выполняется только при явном вызове.
//
// Что делает:
// 1. Хеширует переданный пароль тем же scrypt-форматом, что и authenticate()
// 2. UPDATE admin_users SET password_hash, must_change_password=false WHERE LOWER(username)='admin'
// 3. Если строки 'admin' нет — создаёт её как суперадмина
//
// Безопасность: ADMIN_SECRET не используется. Достаточно доступа к Render Shell
// (или DATABASE_URL локально) — оба требуют входа в Render-аккаунт владельца.

import { pool } from '../db/pool';
import { hashPassword } from '../services/adminAuth.service';

async function main(): Promise<void> {
  const password = process.argv[2];
  if (!password || password.length < 4) {
    console.error('❌ Использование: npm run reset-admin-password -- \'НовыйПароль\' (минимум 4 символа)');
    process.exit(1);
  }

  const hash = hashPassword(password);

  const { rowCount: updated } = await pool.query(
    `UPDATE admin_users
     SET password_hash = $1, must_change_password = false, is_active = true
     WHERE LOWER(username) = 'admin'`,
    [hash]
  );

  if (updated === 0) {
    // Пользователя 'admin' нет — создаём
    await pool.query(
      `INSERT INTO admin_users (username, password_hash, role, is_active)
       VALUES ('admin', $1, 'superadmin', true)`,
      [hash]
    );
    console.log('✅ Создан суперадмин admin с новым паролем.');
  } else {
    console.log('✅ Пароль admin обновлён. Старый больше не работает.');
  }

  await pool.end();
}

main().catch(err => {
  console.error('❌ Ошибка:', err instanceof Error ? err.message : err);
  process.exit(1);
});
