import { plural, coinWord, dayWord, cardWord, monthName, currentPeriod } from '../bot/helpers';

describe('plural', () => {
  it('1 → one', () => {
    expect(plural(1, 'монета', 'монеты', 'монет')).toBe('монета');
    expect(plural(21, 'монета', 'монеты', 'монет')).toBe('монета');
    expect(plural(101, 'монета', 'монеты', 'монет')).toBe('монета');
  });

  it('2-4 → few', () => {
    expect(plural(2, 'монета', 'монеты', 'монет')).toBe('монеты');
    expect(plural(3, 'монета', 'монеты', 'монет')).toBe('монеты');
    expect(plural(4, 'монета', 'монеты', 'монет')).toBe('монеты');
    expect(plural(22, 'монета', 'монеты', 'монет')).toBe('монеты');
    expect(plural(34, 'монета', 'монеты', 'монет')).toBe('монеты');
  });

  it('5-9, 10, 11-19 → many (special case 11-19)', () => {
    expect(plural(5, 'монета', 'монеты', 'монет')).toBe('монет');
    expect(plural(10, 'монета', 'монеты', 'монет')).toBe('монет');
    expect(plural(11, 'монета', 'монеты', 'монет')).toBe('монет');
    expect(plural(12, 'монета', 'монеты', 'монет')).toBe('монет');
    expect(plural(19, 'монета', 'монеты', 'монет')).toBe('монет');
    expect(plural(25, 'монета', 'монеты', 'монет')).toBe('монет');
    expect(plural(100, 'монета', 'монеты', 'монет')).toBe('монет');
  });

  it('0 → many', () => {
    expect(plural(0, 'монета', 'монеты', 'монет')).toBe('монет');
  });

  it('отрицательные: по абсолютному значению', () => {
    expect(plural(-1, 'монета', 'монеты', 'монет')).toBe('монета');
    expect(plural(-5, 'монета', 'монеты', 'монет')).toBe('монет');
  });
});

describe('coinWord/dayWord/cardWord', () => {
  it('coinWord использует «монета/монеты/монет»', () => {
    expect(coinWord(1)).toBe('монета');
    expect(coinWord(2)).toBe('монеты');
    expect(coinWord(5)).toBe('монет');
  });

  it('dayWord использует «день/дня/дней»', () => {
    expect(dayWord(1)).toBe('день');
    expect(dayWord(3)).toBe('дня');
    expect(dayWord(7)).toBe('дней');
    expect(dayWord(11)).toBe('дней');
    expect(dayWord(21)).toBe('день');
  });

  it('cardWord использует «карточка/карточки/карточек»', () => {
    expect(cardWord(1)).toBe('карточка');
    expect(cardWord(3)).toBe('карточки');
    expect(cardWord(5)).toBe('карточек');
  });
});

describe('monthName', () => {
  it('номинатив', () => {
    expect(monthName(1)).toBe('январь');
    expect(monthName(5)).toBe('май');
    expect(monthName(12)).toBe('декабрь');
  });

  it('генитив (за май)', () => {
    expect(monthName(5, true)).toBe('мая');
    expect(monthName(1, true)).toBe('января');
  });
});

describe('currentPeriod', () => {
  it('возвращает иркутский месяц/год', () => {
    const { year, month } = currentPeriod();
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(year).toBeGreaterThan(2024);
  });

  it('на стыке года по UTC даёт иркутский год', () => {
    // 2026-01-01 02:00 Иркутск = 2025-12-31 18:00 UTC
    const fakeNow = Date.UTC(2025, 11, 31, 18, 0, 0);
    const real = Date.now;
    Date.now = () => fakeNow;
    try {
      const { year, month } = currentPeriod();
      expect(year).toBe(2026);
      expect(month).toBe(1);
    } finally {
      Date.now = real;
    }
  });
});
