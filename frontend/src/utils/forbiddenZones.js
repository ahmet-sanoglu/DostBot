// Mühendis panelinde tanımlanan dikdörtgen yasak bölgeler için nokta kontrolü.
// Geofence poligonundan farklı: burada min/max X/Y ile basit dikdörtgen aralığı kullanılır.

/**
 * Dünya koordinatı verilen yasak dikdörtgenlerden birinin içinde mi?
 * zone.minX/maxX/minY/maxY veya alternatif xMin/xMax alan adlarını kabul eder.
 */
export function isPointInForbiddenZone(worldX, worldY, forbiddenZones) {
  if (!forbiddenZones?.length) return false;

  return forbiddenZones.some((zone) => {
    const minX = zone.minX ?? zone.xMin;
    const maxX = zone.maxX ?? zone.xMax;
    const minY = zone.minY ?? zone.yMin;
    const maxY = zone.maxY ?? zone.yMax;

    if (
      typeof minX !== 'number'
      || typeof maxX !== 'number'
      || typeof minY !== 'number'
      || typeof maxY !== 'number'
    ) {
      return false;
    }

    return worldX >= minX && worldX <= maxX && worldY >= minY && worldY <= maxY;
  });
}
