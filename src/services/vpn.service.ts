// Тонкий клиент к vpn-panel (сервис-движок VPN на этом же VPS, host-network
// :8090). Управление людьми — в crew, механика ключей/портов — в панели.
// Auth: X-Service-Token (env SERVICE_TOKEN панели == VPN_SERVICE_TOKEN crew).

const TIMEOUT_MS = 8000;

function baseUrl(): string {
  return process.env.VPN_PANEL_URL ?? 'http://host.docker.internal:8090';
}

export function vpnConfigured(): boolean {
  return !!process.env.VPN_SERVICE_TOKEN;
}

export class VpnEngineError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`vpn-panel ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Ошибка сети/таймаута — панель недоступна (маппится в 502 на роуте). */
export class VpnEngineUnavailable extends Error {}

async function panelFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: globalThis.Response;
  try {
    res = await fetch(baseUrl() + path, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        'x-service-token': process.env.VPN_SERVICE_TOKEN ?? '',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new VpnEngineUnavailable(String(e));
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new VpnEngineError(res.status, json);
  return json as T;
}

export interface PanelUser {
  name: string;
  port: number;
  status: string;
  online: boolean;
  todayBytes: number;
  totalBytes: number;
  lastSeen: number | null;
  pendingCode: boolean;
  codeConflict: { at: number; count: number } | null;
  phoneShared: boolean;
  phone: { status: string } | null;
}

export const listPanelUsers = () => panelFetch<PanelUser[]>('/api/users');

export const addPanelUser = (name: string) =>
  panelFetch<{ user: { name: string }; code: string; tgText: string }>(
    '/api/users', { method: 'POST', body: { name } });

/** Пакетная выдача: один рестарт ss-multi на всю пачку. */
export const bulkAddPanelUsers = (names: string[]) =>
  panelFetch<{
    created: { name: string; code: string; tgText: string }[];
    errors: { name: string; error: string }[];
  }>('/api/users/bulk', { method: 'POST', body: { names } });

export const panelUserDetail = (name: string) =>
  panelFetch<Record<string, unknown>>(`/api/users/${encodeURIComponent(name)}/detail`);

/** Разрешённые прокси-действия панели (whitelist — не даём дёргать произвольные пути). */
export const VPN_ACTIONS = [
  'revoke', 'reactivate', 'reissue', 'unbind',
  'phone', 'phone/revoke', 'phone/reactivate', 'phone/reissue',
] as const;
export type VpnAction = (typeof VPN_ACTIONS)[number];

/** Имя vpn-юзера по имени сотрудника: при коллизии — « (2)», « (3)»… */
export function pickVpnName(base: string, taken: Set<string>): string {
  const name = base.trim();
  let candidate = name;
  for (let i = 2; taken.has(candidate); i++) candidate = `${name} (${i})`;
  return candidate;
}

export const panelUserAction = (name: string, action: VpnAction) =>
  panelFetch<Record<string, unknown>>(
    `/api/users/${encodeURIComponent(name)}/${action}`, { method: 'POST', body: {} });
