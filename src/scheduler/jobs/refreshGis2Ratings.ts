import { refreshAllGis2Ratings } from '../../services/gis2.service';

/**
 * Раз в день обновляет avg_rating_score у всех активных точек из 2ГИС
 * для ТЕКУЩЕГО периода. Если GIS2_API_KEY не задан — no-op с логом
 * (не падает, чтобы не дёргать алерты владельца).
 */
export async function refreshGis2RatingsJob(): Promise<void> {
  if (!process.env.GIS2_API_KEY) {
    console.log('[scheduler] refreshGis2Ratings: GIS2_API_KEY не задан, пропускаем');
    return;
  }
  const result = await refreshAllGis2Ratings();
  console.log(
    `[scheduler] refreshGis2Ratings: total=${result.total} updated=${result.updated} `
    + `skippedNoId=${result.skippedNoId} failed=${result.failed.length}`
  );
  if (result.failed.length > 0) {
    console.log('[scheduler] refreshGis2Ratings failed details:', JSON.stringify(result.failed));
  }
}
