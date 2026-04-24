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

const state: {
  lastWebhookHitAt?: string;
  lastWebhookPayload?: unknown;
  lastUpdate?: UpdateSummary;
  lastBotError?: ErrorSummary;
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

export function getDiagnostics(): Record<string, unknown> {
  return {
    lastWebhookHitAt: state.lastWebhookHitAt ?? null,
    lastWebhookPayload: state.lastWebhookPayload ?? null,
    lastUpdate: state.lastUpdate ?? null,
    lastBotError: state.lastBotError ?? null,
  };
}
