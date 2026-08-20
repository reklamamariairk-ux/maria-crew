const PROXY_BASE = (process.env.UPP_CATALOG_PROXY_URL ?? '').replace(/\/api\/upp\/proxy\/.*$/, '');
const PROXY_KEY = process.env.UPP_CATALOG_PROXY_KEY ?? '';

export type OneCSalesMetric = {
  salesCount: number;
  quantity: number;
  amount: number;
};

export type OneCSalesSummary = {
  period: string;
  gp: OneCSalesMetric;
  site: OneCSalesMetric;
};

export async function getOneCSalesSummary(period: string): Promise<OneCSalesSummary | null> {
  if (!PROXY_BASE || !PROXY_KEY) return null;
  try {
    const url = `${PROXY_BASE}/api/upp/proxy/crew-sales-summary?period=${encodeURIComponent(period)}`;
    const response = await fetch(url, {
      headers: { 'X-API-Key': PROXY_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as Partial<OneCSalesSummary>;
    if (!data.gp || !data.site || data.period !== period) throw new Error('Некорректный ответ');
    return data as OneCSalesSummary;
  } catch (error) {
    console.warn('[1c-sales] Не удалось загрузить сводку:', error instanceof Error ? error.message : error);
    return null;
  }
}
