type UpdateSummary = {
  updateId?: number;
  fromId?: number;
  chatId?: number;
  text?: string;
  at: string;
};

type ErrorSummary = {
  message: string;
  at: string;
};

type WebappAuthSummary = {
  stage: string;
  at: string;
  details?: Record<string, unknown>;
};

const state: {
  lastWebhookHitAt?: string;
  lastWebhookPayload?: unknown;
  lastUpdate?: UpdateSummary;
  lastBotError?: ErrorSummary;
  lastWebappAuth?: WebappAuthSummary;
  dbReady: boolean;
  dbReadyAt?: string;
  dbError?: string;
  startedAt: string;
} = {
  dbReady: false,
  startedAt: new Date().toISOString(),
};

export function markWebhookHit(payload: unknown): void {
  state.lastWebhookHitAt = new Date().toISOString();
  state.lastWebhookPayload = payload;
}

export function markUpdate(payload: {
  updateId?: number;
  fromId?: number;
  chatId?: number;
  text?: string;
}): void {
  state.lastUpdate = {
    ...payload,
    at: new Date().toISOString(),
  };
}

export function markBotError(message: string): void {
  state.lastBotError = {
    message,
    at: new Date().toISOString(),
  };
}

export function markWebappAuth(stage: string, details?: Record<string, unknown>): void {
  state.lastWebappAuth = {
    stage,
    details,
    at: new Date().toISOString(),
  };
}

export function markDbReady(): void {
  state.dbReady = true;
  state.dbReadyAt = new Date().toISOString();
  state.dbError = undefined;
}

export function markDbError(message: string): void {
  state.dbError = message;
}

export function getDiagnostics(): Record<string, unknown> {
  return {
    startedAt: state.startedAt,
    dbReady: state.dbReady,
    dbReadyAt: state.dbReadyAt ?? null,
    dbError: state.dbError ?? null,
    lastWebhookHitAt: state.lastWebhookHitAt ?? null,
    lastUpdate: state.lastUpdate ?? null,
    lastBotError: state.lastBotError ?? null,
    lastWebappAuth: state.lastWebappAuth ?? null,
  };
}
