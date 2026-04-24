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
} = {};

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

export function getDiagnostics(): Record<string, unknown> {
  return {
    lastWebhookHitAt: state.lastWebhookHitAt ?? null,
    lastWebhookPayload: state.lastWebhookPayload ?? null,
    lastUpdate: state.lastUpdate ?? null,
    lastBotError: state.lastBotError ?? null,
    lastWebappAuth: state.lastWebappAuth ?? null,
  };
}
