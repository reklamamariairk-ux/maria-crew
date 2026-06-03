import { calcCardAwards } from '../services/card.service';
import type { MonthlyMetrics } from '../types';

function metrics(over: Partial<MonthlyMetrics> = {}): MonthlyMetrics {
  return {
    id: 1, employeeId: 1, storeId: 1, year: 2026, month: 5,
    mysteryShopperScore: null, reviewsCount: 0,
    checklistPercent: null, revenuePercent: null,
    attestationPercent: null,
    mvpScore: null, isMvp: false, cardsAwarded: [],
    createdAt: new Date(), updatedAt: new Date(), processedAt: null,
    ...over,
  } as unknown as MonthlyMetrics;
}

describe('calcCardAwards', () => {
  it('пустые метрики → 0 карточек', () => {
    expect(calcCardAwards(metrics())).toEqual([]);
  });

  it('тайный покупатель ≥90 → +1 карточка', () => {
    expect(calcCardAwards(metrics({ mysteryShopperScore: 90 }))).toEqual([
      { source: 'mystery_shopper', isMvp: false },
    ]);
    expect(calcCardAwards(metrics({ mysteryShopperScore: 89 }))).toEqual([]);
  });

  it('за отзывы карточки больше НЕ выдаются (только монеты)', () => {
    expect(calcCardAwards(metrics({ reviewsCount: 1 }))).toEqual([]);
    expect(calcCardAwards(metrics({ reviewsCount: 5 }))).toEqual([]);
  });

  it('чек-лист 100% → +1', () => {
    expect(calcCardAwards(metrics({ checklistPercent: 100 }))).toEqual([
      { source: 'checklist', isMvp: false },
    ]);
    expect(calcCardAwards(metrics({ checklistPercent: 99 }))).toEqual([]);
  });

  it('план ≥105% → +1', () => {
    expect(calcCardAwards(metrics({ revenuePercent: 105 }))).toEqual([
      { source: 'plan', isMvp: false },
    ]);
    expect(calcCardAwards(metrics({ revenuePercent: 104 }))).toEqual([]);
  });

  it('аттестация ≥80% → +1 certification', () => {
    expect(calcCardAwards(metrics({ attestationPercent: 80 }))).toEqual([
      { source: 'certification', isMvp: false },
    ]);
    expect(calcCardAwards(metrics({ attestationPercent: 79 }))).toEqual([]);
  });

  it('isMvp → +особая карточка со звездой', () => {
    expect(calcCardAwards(metrics({ isMvp: true }))).toEqual([
      { source: 'mvp', isMvp: true },
    ]);
  });

  it('идеальный месяц: тайный + чек-лист + план + аттестация + mvp = 5 (без review)', () => {
    const awards = calcCardAwards(metrics({
      mysteryShopperScore: 95, reviewsCount: 3,
      checklistPercent: 100, revenuePercent: 110,
      attestationPercent: 90, isMvp: true,
    }));
    expect(awards.length).toBe(5);
    expect(awards.filter(a => a.source === 'review').length).toBe(0);
    expect(awards.find(a => a.source === 'mvp')?.isMvp).toBe(true);
    expect(awards.find(a => a.source === 'certification')).toBeTruthy();
  });

  it('пороги из cfg применяются', () => {
    const cfg = {
      cardThresholdMysteryShopper: 95,
      cardThresholdChecklist: 110,
      cardThresholdRevenue: 120,
      cardThresholdCertification: 90,
    };
    expect(calcCardAwards(metrics({ mysteryShopperScore: 92 }), cfg)).toEqual([]);
    expect(calcCardAwards(metrics({ mysteryShopperScore: 95 }), cfg)).toEqual([
      { source: 'mystery_shopper', isMvp: false },
    ]);
    expect(calcCardAwards(metrics({ checklistPercent: 105 }), cfg)).toEqual([]);
    expect(calcCardAwards(metrics({ revenuePercent: 115 }), cfg)).toEqual([]);
    expect(calcCardAwards(metrics({ attestationPercent: 85 }), cfg)).toEqual([]);
    expect(calcCardAwards(metrics({ attestationPercent: 90 }), cfg)).toEqual([
      { source: 'certification', isMvp: false },
    ]);
  });
});
