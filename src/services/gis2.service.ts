const GIS2_API = 'https://catalog.api.2gis.com/3.0/items/byid';

export async function fetchGis2Rating(gis2Id: string): Promise<number | null> {
  const key = process.env.GIS2_API_KEY;
  if (!key) return null;

  const url = `${GIS2_API}?id=${encodeURIComponent(gis2Id)}&fields=items.reviews&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;

  const data = await res.json() as { result?: { items?: Array<{ reviews?: { rating_value?: number } }> } };
  const rating = data?.result?.items?.[0]?.reviews?.rating_value;
  return typeof rating === 'number' ? rating : null;
}
