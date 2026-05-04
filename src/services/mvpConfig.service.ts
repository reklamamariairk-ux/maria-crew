import { pool } from '../db/pool';

export interface MvpConfig {
  id: number;
  mysteryShopperWeight: number;
  reviewsPerCard: number;
  reviewsMax: number;
  checklistWeight: number;
  revenueWeightFactor: number;
  revenueMax: number;
  mvpCoinReward: number;
  topStoreCoinReward: number;
  updatedAt: Date;
}

let cached: MvpConfig | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

const DEFAULT_CONFIG: MvpConfig = {
  id: 1,
  mysteryShopperWeight: 30,
  reviewsPerCard: 5,
  reviewsMax: 25,
  checklistWeight: 25,
  revenueWeightFactor: 20,
  revenueMax: 25,
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
      reviewsPerCard: string;
      reviewsMax: string;
      checklistWeight: string;
      revenueWeightFactor: string;
      revenueMax: string;
      mvpCoinReward: number | string | null;
      topStoreCoinReward: number | string | null;
      updatedAt: Date;
    }>(`SELECT * FROM mvp_config ORDER BY id LIMIT 1`);

    if (!rows[0]) return DEFAULT_CONFIG;

    const r = rows[0];
    cached = {
      id: r.id,
      mysteryShopperWeight: parseFloat(r.mysteryShopperWeight),
      reviewsPerCard: parseFloat(r.reviewsPerCard),
      reviewsMax: parseFloat(r.reviewsMax),
      checklistWeight: parseFloat(r.checklistWeight),
      revenueWeightFactor: parseFloat(r.revenueWeightFactor),
      revenueMax: parseFloat(r.revenueMax),
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
    mystery_shopper_weight: 'mysteryShopperWeight',
    reviews_per_card:       'reviewsPerCard',
    reviews_max:            'reviewsMax',
    checklist_weight:       'checklistWeight',
    revenue_weight_factor:  'revenueWeightFactor',
    revenue_max:            'revenueMax',
    mvp_coin_reward:        'mvpCoinReward',
    top_store_coin_reward:  'topStoreCoinReward',
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
