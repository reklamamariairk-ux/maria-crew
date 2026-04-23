// ─── Справочники ────────────────────────────────────────────────────────────

export type Role = 'employee' | 'manager' | 'admin';

export type CardSource =
  | 'mystery_shopper'
  | 'review'
  | 'checklist'
  | 'plan'
  | 'mvp'
  | 'team_bonus'
  | 'seasonal'
  | 'manual';

export type CoinReason =
  | 'checklist_day'
  | 'review'
  | 'cake_order'
  | 'substitution'
  | 'mentoring'
  | 'idea'
  | 'spend'
  | 'manual';

export type PrizeType =
  | 'cake'
  | 'certificate'
  | 'cash'
  | 'shift_choice'
  | 'golden_badge'
  | 'coffee'
  | 'discount'
  | 'merch'
  | 'break';

export type ExchangeStatus = 'pending' | 'approved' | 'rejected' | 'fulfilled';

export type Season = 'summer' | 'autumn' | 'winter' | 'spring';

// ─── Сущности БД ────────────────────────────────────────────────────────────

export interface Store {
  id: number;
  name: string;
  address: string | null;
  telegramChatId: bigint | null;
  isActive: boolean;
  createdAt: Date;
}

export interface Employee {
  id: number;
  telegramId: bigint | null;
  name: string;
  storeId: number;
  role: Role;
  isActive: boolean;
  joinedAt: Date | null;
  createdAt: Date;
}

export interface Hero {
  id: number;
  name: string;
  description: string | null;
  imageUrl: string | null;
  isLimited: boolean;
  season: Season | null;
  sortOrder: number;
}

export interface EmployeeCard {
  id: number;
  employeeId: number;
  heroId: number;
  isMvp: boolean;
  source: CardSource;
  year: number;
  month: number;
  isSpent: boolean;
  earnedAt: Date;
}

export interface CoinTransaction {
  id: number;
  employeeId: number;
  amount: number;
  reason: CoinReason;
  refId: number | null;
  note: string | null;
  createdBy: number | null;
  createdAt: Date;
}

export interface MonthlyMetrics {
  id: number;
  employeeId: number;
  storeId: number;
  year: number;
  month: number;
  mysteryShopperScore: number | null;
  reviewsCount: number;
  checklistPercent: number | null;
  revenuePercent: number | null;
  mvpScore: number | null;
  isMvp: boolean;
  cardsAwarded: CardAwardLog[];
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoreMonthlyStats {
  id: number;
  storeId: number;
  year: number;
  month: number;
  avgMysteryshopper: number | null;
  avgRatingScore: number | null;
  avgChecklist: number | null;
  revenuePercent: number | null;
  totalScore: number | null;
  rank: number | null;
  isTop: boolean;
  processedAt: Date | null;
  createdAt: Date;
}

export interface Prize {
  id: number;
  name: string;
  description: string | null;
  prizeType: PrizeType;
  cardsRequired: number;
  coinsRequired: number;
  isActive: boolean;
  sortOrder: number;
}

export interface StoreExchange {
  id: number;
  employeeId: number;
  prizeId: number;
  cardsSpent: number;
  coinsSpent: number;
  cardIds: number[] | null;
  status: ExchangeStatus;
  notes: string | null;
  processedBy: number | null;
  createdAt: Date;
  processedAt: Date | null;
}

// ─── Служебные типы сервисов ─────────────────────────────────────────────────

export interface CardAwardLog {
  heroId: number;
  source: CardSource;
  isMvp: boolean;
}

/** Одна «причина» для начисления карточки, выведенная из метрик */
export interface CardAwardItem {
  source: CardSource;
  isMvp: boolean;
}

export interface CollectionSummary {
  cards: (EmployeeCard & { heroName: string })[];
  /** Уникальных основных героев (из 12) */
  uniqueHeroes: number;
  totalCards: number;
  availableCards: number;
  hasFullCollection: boolean;
}

export interface MonthlyMetricsInput {
  employeeId: number;
  storeId: number;
  year: number;
  month: number;
  mysteryShopperScore?: number;
  reviewsCount?: number;
  checklistPercent?: number;
  revenuePercent?: number;
}

export interface ProcessMonthResult {
  year: number;
  month: number;
  storeId: number;
  employees: Array<{
    employeeId: number;
    name: string;
    mvpScore: number;
    isMvp: boolean;
    cardsAwarded: number;
  }>;
  topStore: boolean;
  storeScore: number;
  storeRank: number;
}

export interface EmployeeRanking {
  employeeId: number;
  name: string;
  mvpScore: number;
  isMvp: boolean;
  cardsCount: number;
  coinsBalance: number;
}

export interface StoreRanking {
  storeId: number;
  storeName: string;
  totalScore: number;
  rank: number;
  isTop: boolean;
}
