import { refreshAllGis2Ratings } from '../../services/gis2.service';

/**
 * Раз в день обновляет avg_rating_score у всех активных точек из 2ГИС
 * для ТЕКУЩЕГО периода. Рейтинг идёт через прокси sales-dashboard
 * (UPP_CATALOG_PROXY_URL/KEY) — без него gis2.service сам вернёт ошибки
 * по каждой точке, они попадут в failed-лог ниже.
 */
export async function refreshGis2RatingsJob(): Promise<void> {
  const result = await refreshAllGis2Ratings();
  console.log(
    `[scheduler] refreshGis2Ratings: total=${result.total} updated=${result.updated} `
    + `skippedNoId=${result.skippedNoId} failed=${result.failed.length}`
  );
  if (result.failed.length > 0) {
    console.log('[scheduler] refreshGis2Ratings failed details:', JSON.stringify(result.failed));
  }
}
