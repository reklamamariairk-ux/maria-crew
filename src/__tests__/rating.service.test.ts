import { calcMvpScore, calcStoreScore } from '../services/rating.service';

describe('calcMvpScore', () => {
  // Веса по умолчанию (после 06.2026): тайный 0 (выключен) + порог 80, отзывы 5/шт max 25,
  // чек-лист 25 + порог 70, план 20× max 25.
  const defaultCfg = {
    mysteryShopperWeight: 0,
    mysteryShopperThreshold: 80,
    reviewsPerCard: 5,
    reviewsMax: 25,
    checklistWeight: 25,
    checklistThreshold: 70,
    revenueWeightFactor: 20,
    revenueMax: 25,
  };

  it('returns 0 when all metrics are null', () => {
    expect(calcMvpScore({
      mysteryShopperScore: null, reviewsCount: 0,
      checklistPercent: null, revenuePercent: null,
    }, defaultCfg)).toBe(0);
  });

  it('тайный с weight=0 не влияет ни в плюс, ни в минус', () => {
    expect(calcMvpScore({
      mysteryShopperScore: 100, reviewsCount: 0,
      checklistPercent: null, revenuePercent: null,
    }, defaultCfg)).toBe(0);
    expect(calcMvpScore({
      mysteryShopperScore: 0, reviewsCount: 0,
      checklistPercent: null, revenuePercent: null,
    }, defaultCfg)).toBe(0);
  });

  it('тайный при weight=30: 100 → +30, 80 → 0, 0 → −30', () => {
    const cfg = { ...defaultCfg, mysteryShopperWeight: 30 };
    expect(calcMvpScore({ mysteryShopperScore: 100, reviewsCount: 0, checklistPercent: null, revenuePercent: null }, cfg)).toBe(30);
    expect(calcMvpScore({ mysteryShopperScore: 80,  reviewsCount: 0, checklistPercent: null, revenuePercent: null }, cfg)).toBe(0);
    expect(calcMvpScore({ mysteryShopperScore: 0,   reviewsCount: 0, checklistPercent: null, revenuePercent: null }, cfg)).toBe(-30);
    // 90 → (90−80)/20 × 30 = 15
    expect(calcMvpScore({ mysteryShopperScore: 90, reviewsCount: 0, checklistPercent: null, revenuePercent: null }, cfg)).toBe(15);
    // 40 → −(80−40)/80 × 30 = −15
    expect(calcMvpScore({ mysteryShopperScore: 40, reviewsCount: 0, checklistPercent: null, revenuePercent: null }, cfg)).toBe(-15);
  });

  it('чек-лист: 100 → +25, 70 → 0, 0 → −25', () => {
    expect(calcMvpScore({ mysteryShopperScore: null, reviewsCount: 0, checklistPercent: 100, revenuePercent: null }, defaultCfg)).toBe(25);
    expect(calcMvpScore({ mysteryShopperScore: null, reviewsCount: 0, checklistPercent: 70,  revenuePercent: null }, defaultCfg)).toBe(0);
    expect(calcMvpScore({ mysteryShopperScore: null, reviewsCount: 0, checklistPercent: 0,   revenuePercent: null }, defaultCfg)).toBe(-25);
    // 85 → (85−70)/30 × 25 = 12.5
    expect(calcMvpScore({ mysteryShopperScore: null, reviewsCount: 0, checklistPercent: 85, revenuePercent: null }, defaultCfg)).toBe(12.5);
    // 35 → −(70−35)/70 × 25 = −12.5
    expect(calcMvpScore({ mysteryShopperScore: null, reviewsCount: 0, checklistPercent: 35, revenuePercent: null }, defaultCfg)).toBe(-12.5);
  });

  it('reviews: каждый отзыв = +5, max 25', () => {
    const s3 = calcMvpScore({ mysteryShopperScore: null, reviewsCount: 3, checklistPercent: null, revenuePercent: null }, defaultCfg);
    expect(s3).toBe(15);

    // 10 отзывов — обрезается на 25
    const s10 = calcMvpScore({ mysteryShopperScore: null, reviewsCount: 10, checklistPercent: null, revenuePercent: null }, defaultCfg);
    expect(s10).toBe(25);
  });

  it('revenue: 100% плана → 20, но при 200% обрезается на 25', () => {
    const s100 = calcMvpScore({ mysteryShopperScore: null, reviewsCount: 0, checklistPercent: null, revenuePercent: 100 }, defaultCfg);
    expect(s100).toBe(20);
    const s200 = calcMvpScore({ mysteryShopperScore: null, reviewsCount: 0, checklistPercent: null, revenuePercent: 200 }, defaultCfg);
    expect(s200).toBe(25);
  });

  it('идеальный сотрудник при выключенном тайном: 0 + 25 + 25 + 25 = 75', () => {
    const score = calcMvpScore({
      mysteryShopperScore: 100, reviewsCount: 5,
      checklistPercent: 100, revenuePercent: 200,
    }, defaultCfg);
    expect(score).toBe(75);
  });

  it('итог может быть отрицательным', () => {
    // чек 0% (−25) + 0 отзывов + 0 план → −25
    const score = calcMvpScore({
      mysteryShopperScore: null, reviewsCount: 0,
      checklistPercent: 0, revenuePercent: 0,
    }, defaultCfg);
    expect(score).toBe(-25);
  });
});

describe('calcStoreScore', () => {
  // Формула точки не меняется в этой итерации.
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
