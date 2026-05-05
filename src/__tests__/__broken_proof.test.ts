/* ВРЕМЕННЫЙ ТЕСТ для проверки что Render действительно запускает npm test
 * перед build. Этот файл должен упасть → Render не должен передеплоить.
 * Удаляется сразу после проверки. */

describe('CI proof', () => {
  it('intentionally fails to verify Render runs npm test', () => {
    expect(true).toBe(false);
  });
});
