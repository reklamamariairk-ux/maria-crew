/* ВРЕМЕННЫЙ ТЕСТ — проверка что Render теперь правильно запускает npm test
 * после обновления Build Command в dashboard. Удаляется сразу после проверки. */

describe('CI proof v2', () => {
  it('intentionally fails — deploy must be blocked', () => {
    expect(true).toBe(false);
  });
});
