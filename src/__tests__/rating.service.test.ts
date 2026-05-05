import { calcMvpScore, calcStoreScore } from '../services/rating.service';

describe('calcMvpScore', () => {
  // Веса по умолчанию: тайный 30%, отзывы (5 за каждый, max 25), чек-лист 25%, план 20% (max 25)
  const defaultCfg = {
    mysteryShopperWeight: 30,
    reviewsPerCard: 5,
    reviewsMax: 25,
    checklistWeight: 25,
    revenueWeightFactor: 20,
    revenueMax: 25,
  };

  it('returns 0 when all metrics are null', () => {
    expect(calcMvpScore({
      mysteryShopperScore: null, reviewsCount: 0,
      checklistPercent: null, revenuePercent: null,
    }, defaultCfg)).toBe(0);
  });

  it('mystery shopper: 100/100 → 30 баллов', () => {
    const score = calcMvpScore({
      mysteryShopperScore: 100, reviewsCount: 0,
      checklistPercent: null, revenuePercent: null,
    }, defaultCfg);
    expect(score).toBe(30);
  });

  it('reviews: каждый отзыв = +5, max 25', () => {
    const s3 = calcMvpScore({ mysteryShopperScore: null, reviewsCount: 3, checklistPercent: null, revenuePercent: null }, defaultCfg);
    expect(s3).toBe(15);

    // 10 отзывов — обрезается на 25 (Math.min)
    const s10 = calcMvpScore({ mysteryShopperScore: null, reviewsCount: 10, checklistPercent: null, revenuePercent: null }, defaultCfg);
    expect(s10).toBe(25);
  });

  it('checklist: 100% → 25 баллов', () => {
    const score = calcMvpScore({
      mysteryShopperScore: null, reviewsCount: 0,
      checklistPercent: 100, revenuePercent: null,
    }, defaultCfg);
    expect(score).toBe(25);
  });

  it('revenue: 100% плана → 20, но при 200% обрезается на 25', () => {
    const s100 = calcMvpScore({ mysteryShopperScore: null, reviewsCount: 0, checklistPercent: null, revenuePercent: 100 }, defaultCfg);
    expect(s100).toBe(20);

    const s200 = calcMvpScore({ mysteryShopperScore: null, reviewsCount: 0, checklistPercent: null, revenuePercent: 200 }, defaultCfg);
    expect(s200).toBe(25); // capped by revenueMax
  });

  it('идеальный сотрудник = max possible: 30 + 25 + 25 + 25 = 105', () => {
    const score = calcMvpScore({
      mysteryShopperScore: 100, reviewsCount: 5,
      checklistPercent: 100, revenuePercent: 200,
    }, defaultCfg);
    expect(score).toBe(105);
  });

  it('округляется до 2 знаков', () => {
    const score = calcMvpScore({
      mysteryShopperScore: 33.333, reviewsCount: 0,
      checklistPercent: null, revenuePercent: null,
    }, defaultCfg);
    // 33.333 / 100 * 30 = 9.9999 → округление до 2 знаков
    expect(score).toBe(10);
  });
});

describe('calcStoreScore', () => {
  // Тайный 30% + рейтинг отзовиков 25% (0-5 звёзд) + чек-лист 25% + план 20%
  it('всё максимум: 30+25+25+20 = 100', () => {
    const score = calcStoreScore({
      avgMysteryShoper: 100, avgRatingScore: 5,
      avgChecklist: 100, revenuePercent: 100,
    });
    expect(score).toBe(100);
  });

  it('все нули = 0', () => {
    expect(calcStoreScore({
      avgMysteryShoper: null, avgRatingScore: null,
      avgChecklist: null, revenuePercent: null,
    })).toBe(0);
  });

  it('revenue capped на 25 при перевыполнении плана', () => {
    // план 200% → 200/100*20 = 40, но cap на 25
    const score = calcStoreScore({
      avgMysteryShoper: null, avgRatingScore: null,
      avgChecklist: null, revenuePercent: 200,
    });
    expect(score).toBe(25);
  });

  it('средний рейтинг отзовиков 4.5 → 4.5/5 × 25 = 22.5', () => {
    const score = calcStoreScore({
      avgMysteryShoper: null, avgRatingScore: 4.5,
      avgChecklist: null, revenuePercent: null,
    });
    expect(score).toBe(22.5);
  });
});
