import { calcCardAwards } from '../services/card.service';
import type { MonthlyMetrics } from '../types';

function metrics(over: Partial<MonthlyMetrics> = {}): MonthlyMetrics {
  return {
    id: 1, employeeId: 1, storeId: 1, year: 2026, month: 5,
    mysteryShopperScore: null, reviewsCount: 0,
    checklistPercent: null, revenuePercent: null,
    mvpScore: null, isMvp: false, cardsAwarded: null,
    createdAt: new Date(), updatedAt: new Date(), processedAt: null,
    ...over,
  } as MonthlyMetrics;
}

describe('calcCardAwards', () => {
  it('пустые метрики → 0 карточек', () => {
    expect(calcCardAwards(metrics())).toEqual([]);
  });

  it('тайный покупатель ≥90 → +1 карточка', () => {
    expect(calcCardAwards(metrics({ mysteryShopperScore: 90 }))).toEqual([
      { source: 'mystery_shopper', isMvp: false },
    ]);
    // 89 — нет
    expect(calcCardAwards(metrics({ mysteryShopperScore: 89 }))).toEqual([]);
  });

  it('отзывы: каждый отзыв = +1 карточка, max 2 за месяц', () => {
    expect(calcCardAwards(metrics({ reviewsCount: 1 })).length).toBe(1);
    expect(calcCardAwards(metrics({ reviewsCount: 2 })).length).toBe(2);
    // 5 отзывов — всё равно 2 карточки
    expect(calcCardAwards(metrics({ reviewsCount: 5 })).length).toBe(2);
  });

  it('чек-лист 100% → +1', () => {
    expect(calcCardAwards(metrics({ checklistPercent: 100 }))).toEqual([
      { source: 'checklist', isMvp: false },
    ]);
    // 99 — нет
    expect(calcCardAwards(metrics({ checklistPercent: 99 }))).toEqual([]);
  });

  it('план ≥105% → +1', () => {
    expect(calcCardAwards(metrics({ revenuePercent: 105 }))).toEqual([
      { source: 'plan', isMvp: false },
    ]);
    // 104 — нет
    expect(calcCardAwards(metrics({ revenuePercent: 104 }))).toEqual([]);
  });

  it('isMvp → +особая карточка со звездой', () => {
    expect(calcCardAwards(metrics({ isMvp: true }))).toEqual([
      { source: 'mvp', isMvp: true },
    ]);
  });

  it('идеальный месяц: тайный + 2 отзыва + чек-лист + план + mvp = 6 карточек', () => {
    const awards = calcCardAwards(metrics({
      mysteryShopperScore: 95, reviewsCount: 3, // 3 отзыва, но cap на 2
      checklistPercent: 100, revenuePercent: 110,
      isMvp: true,
    }));
    expect(awards.length).toBe(6);
    expect(awards.filter(a => a.source === 'review').length).toBe(2);
    expect(awards.find(a => a.source === 'mvp')?.isMvp).toBe(true);
  });
});
