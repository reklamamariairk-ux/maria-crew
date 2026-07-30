/**
 * Регресс бага июня-2026: pg NUMERIC приходит строками, и рейтинг точек
 * обнулялся (calcStoreScore игнорировал «4.60»), а карточка «тайный покупатель»
 * выдавалась при отключённой программе (вес 0).
 */
import { calcStoreScore, toNum } from '../services/rating.service';
import { calcCardAwards } from '../services/card.service';
import type { MonthlyMetrics } from '../types';

describe('toNum — числовая граница pg', () => {
  test.each([
    ['4.60', 4.6],
    ['101.20', 101.2],
    [4.6, 4.6],
    [0, 0],
    ['0.00', 0],
  ])('%p → %p', (input, expected) => expect(toNum(input)).toBe(expected));

  test.each([[null], [undefined], [''], ['   '], ['abc'], [NaN], [Infinity]])(
    '%p → null', (input) => expect(toNum(input as never)).toBeNull());
});

describe('calcStoreScore — принимает строки из pg', () => {
  test('строковый рейтинг 4.60 больше не обнуляется (баг июня-2026)', () => {
    const score = calcStoreScore({
      avgMysteryShoper: null,
      avgRatingScore: '4.60' as unknown as number,
      avgChecklist: null,
      revenuePercent: '99.20' as unknown as number,
    });
    // rating 4.6/5*25 = 23, revenue 99.2/100*20 = 19.84 → 42.84
    expect(score).toBeCloseTo(42.84, 2);
  });

  test('числа работают как раньше', () => {
    expect(calcStoreScore({ avgMysteryShoper: 100, avgRatingScore: 5, avgChecklist: 100, revenuePercent: 100 }))
      .toBeCloseTo(30 + 25 + 25 + 20, 2);
  });
});

describe('calcCardAwards — гейт «тайного покупателя» по весу программы', () => {
  const metrics = {
    mysteryShopperScore: 100, checklistPercent: null, revenuePercent: null,
    attestationPercent: null, reviewsCount: 0, isMvp: false,
  } as unknown as MonthlyMetrics;
  const thresholds = {
    cardThresholdMysteryShopper: 90, cardThresholdChecklist: 100,
    cardThresholdRevenue: 105, cardThresholdCertification: 80,
  };

  test('вес 0 (программа отключена) → карточки НЕТ', () => {
    const awards = calcCardAwards(metrics, { ...thresholds, mysteryShopperWeight: 0 });
    expect(awards.find(a => a.source === 'mystery_shopper')).toBeUndefined();
  });

  test('вес > 0 → карточка есть', () => {
    const awards = calcCardAwards(metrics, { ...thresholds, mysteryShopperWeight: 20 });
    expect(awards.find(a => a.source === 'mystery_shopper')).toBeTruthy();
  });

  test('вес не передан (back-compat) → карточка есть', () => {
    const awards = calcCardAwards(metrics, thresholds);
    expect(awards.find(a => a.source === 'mystery_shopper')).toBeTruthy();
  });
});
