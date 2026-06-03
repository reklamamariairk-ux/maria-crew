import { pool } from '../db/pool';

export interface MvpConfig {
  id: number;
  mysteryShopperWeight: number;
  mysteryShopperThreshold: number;
  reviewsPerCard: number;
  reviewsMax: number;
  checklistWeight: number;
  checklistThreshold: number;
  revenueWeightFactor: number;
  revenueMax: number;
  // Пороги выдачи карточек (отдельно от весов MVP)
  cardThresholdMysteryShopper: number;
  cardThresholdChecklist: number;
  cardThresholdRevenue: number;
  cardThresholdCertification: number;
  cardMaxReviewsCount: number;
  // Пороги назначения MVP/топ-точки (если max ниже — никого не назначаем)
  mvpMinScore: number;
  topStoreMinScore: number;
  reviewCoinReward: number;
  mvpCoinReward: number;
  topStoreCoinReward: number;
  updatedAt: Date;
}

let cached: MvpConfig | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

const DEFAULT_CONFIG: MvpConfig = {
  id: 1,
  mysteryShopperWeight: 0,
  mysteryShopperThreshold: 80,
  reviewsPerCard: 5,
  reviewsMax: 25,
  checklistWeight: 25,
  checklistThreshold: 70,
  revenueWeightFactor: 20,
  revenueMax: 25,
  cardThresholdMysteryShopper: 90,
  cardThresholdChecklist: 100,
  cardThresholdRevenue: 105,
  cardThresholdCertification: 80,
  cardMaxReviewsCount: 2,
  mvpMinScore: 40,
  topStoreMinScore: 70,
  reviewCoinReward: 5,
  mvpCoinReward: 0,
  topStoreCoinReward: 0,
  updatedAt: new Date(),
};

export async function getMvpConfig(): Promise<MvpConfig> {
  const now = Date.now();
  if (cached && now - cacheTime < CACHE_TTL_MS) return cached;

  try {
    // pool автоматически переводит snake_case колонки в camelCase
    const { rows } = await pool.query<{
      id: number;
      mysteryShopperWeight: string;
      mysteryShopperThreshold: string | null;
      reviewsPerCard: string;
      reviewsMax: string;
      checklistWeight: string;
      checklistThreshold: string | null;
      revenueWeightFactor: string;
      revenueMax: string;
      cardThresholdMysteryShopper: string | null;
      cardThresholdChecklist: string | null;
      cardThresholdRevenue: string | null;
      cardThresholdCertification: string | null;
      cardMaxReviewsCount: number | string | null;
      mvpMinScore: string | null;
      topStoreMinScore: string | null;
      reviewCoinReward: number | string | null;
      mvpCoinReward: number | string | null;
      topStoreCoinReward: number | string | null;
      updatedAt: Date;
    }>(`SELECT * FROM mvp_config ORDER BY id LIMIT 1`);

    if (!rows[0]) return DEFAULT_CONFIG;

    const r = rows[0];
    cached = {
      id: r.id,
      mysteryShopperWeight: parseFloat(r.mysteryShopperWeight),
      mysteryShopperThreshold: r.mysteryShopperThreshold != null ? parseFloat(r.mysteryShopperThreshold) : 80,
      reviewsPerCard: parseFloat(r.reviewsPerCard),
      reviewsMax: parseFloat(r.reviewsMax),
      checklistWeight: parseFloat(r.checklistWeight),
      checklistThreshold: r.checklistThreshold != null ? parseFloat(r.checklistThreshold) : 70,
      revenueWeightFactor: parseFloat(r.revenueWeightFactor),
      revenueMax: parseFloat(r.revenueMax),
      cardThresholdMysteryShopper: r.cardThresholdMysteryShopper != null ? parseFloat(r.cardThresholdMysteryShopper) : 90,
      cardThresholdChecklist: r.cardThresholdChecklist != null ? parseFloat(r.cardThresholdChecklist) : 100,
      cardThresholdRevenue: r.cardThresholdRevenue != null ? parseFloat(r.cardThresholdRevenue) : 105,
      cardThresholdCertification: r.cardThresholdCertification != null ? parseFloat(r.cardThresholdCertification) : 80,
      cardMaxReviewsCount: r.cardMaxReviewsCount != null ? Number(r.cardMaxReviewsCount) : 2,
      mvpMinScore: r.mvpMinScore != null ? parseFloat(r.mvpMinScore) : 80,
      topStoreMinScore: r.topStoreMinScore != null ? parseFloat(r.topStoreMinScore) : 70,
      reviewCoinReward: r.reviewCoinReward != null ? Number(r.reviewCoinReward) : 5,
      mvpCoinReward: r.mvpCoinReward != null ? Number(r.mvpCoinReward) : 0,
      topStoreCoinReward: r.topStoreCoinReward != null ? Number(r.topStoreCoinReward) : 0,
      updatedAt: r.updatedAt,
    };
    cacheTime = now;
    return cached;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function updateMvpConfig(
  data: Partial<Omit<MvpConfig, 'id' | 'updatedAt'>>
): Promise<MvpConfig> {
  cached = null;
  const fields: string[] = [];
  const vals: number[] = [];

  const map: Record<string, keyof typeof data> = {
    mystery_shopper_weight:         'mysteryShopperWeight',
    mystery_shopper_threshold:      'mysteryShopperThreshold',
    reviews_per_card:               'reviewsPerCard',
    reviews_max:                    'reviewsMax',
    checklist_weight:               'checklistWeight',
    checklist_threshold:            'checklistThreshold',
    revenue_weight_factor:          'revenueWeightFactor',
    revenue_max:                    'revenueMax',
    card_threshold_mystery_shopper:  'cardThresholdMysteryShopper',
    card_threshold_checklist:        'cardThresholdChecklist',
    card_threshold_revenue:          'cardThresholdRevenue',
    card_threshold_certification:    'cardThresholdCertification',
    card_max_reviews_count:          'cardMaxReviewsCount',
    mvp_min_score:                   'mvpMinScore',
    top_store_min_score:             'topStoreMinScore',
    review_coin_reward:              'reviewCoinReward',
    mvp_coin_reward:                'mvpCoinReward',
    top_store_coin_reward:          'topStoreCoinReward',
  };

  for (const [col, key] of Object.entries(map)) {
    const val = data[key];
    if (val !== undefined) {
      vals.push(Number(val));
      fields.push(`${col} = $${vals.length}`);
    }
  }

  if (fields.length === 0) return getMvpConfig();

  fields.push(`updated_at = NOW()`);
  await pool.query(
    `UPDATE mvp_config SET ${fields.join(', ')} WHERE id = 1`,
    vals
  );

  return getMvpConfig();
}

export function invalidateCache(): void {
  cached = null;
}
