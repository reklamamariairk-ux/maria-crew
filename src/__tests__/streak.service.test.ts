import { irkutskDate } from '../services/streak.service';

describe('irkutskDate', () => {
  // Иркутск = UTC+8
  it('возвращает YYYY-MM-DD по иркутскому дню', () => {
    const today = irkutskDate();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('offsetDays=-1 даёт вчерашний день', () => {
    const today = new Date(irkutskDate());
    const yest = new Date(irkutskDate(-1));
    const diffMs = today.getTime() - yest.getTime();
    expect(diffMs).toBe(24 * 60 * 60 * 1000);
  });

  it('offsetDays=+7 даёт +7 дней', () => {
    const today = new Date(irkutskDate());
    const future = new Date(irkutskDate(7));
    const diffDays = (future.getTime() - today.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(7);
  });

  it('на стыке дня по UTC всё равно даёт правильный иркутский день', () => {
    // 2026-01-01 02:00 Иркутск = 2025-12-31 18:00 UTC
    // irkutskDate должна вернуть «2026-01-01» в этот момент
    const fakeNow = Date.UTC(2025, 11, 31, 18, 0, 0); // 31 dec 2025 18:00 UTC
    const realNow = Date.now;
    Date.now = () => fakeNow;
    try {
      // 18:00 UTC + 8 = 2:00 Иркутск 1 января 2026 → дата «2026-01-01»
      expect(irkutskDate()).toBe('2026-01-01');
    } finally {
      Date.now = realNow;
    }
  });
});
