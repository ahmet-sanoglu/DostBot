// Harita PNG'sindeki piksel rengine bakarak hedef noktanın geçilebilir olup olmadığını kontrol eder.
// Sıra: occupancy piksel → geofence poligonu → yasak dikdörtgen bölge.
// Operatör görev başlatmadan önce bu üç katmanlı kontrolden geçer.

import { isPointInForbiddenZone } from './forbiddenZones';
import { isPointInPolygon } from './geofence';

/**
 * Occupancy grid PNG eşik değeri (0–255 gri tonu).
 * ~254 beyaz = geçilebilir alan, ~205 gri = bilinmeyen, ~0 siyah = engel/duvar.
 * 240 seçildi: beyazdan biraz düşük — gri/belirsiz pikselleri de engel sayarak güvenlik marjı bırakır.
 */
export const FREE_SPACE_THRESHOLD = 240;

/**
 * Dünya koordinatını (metre) harita PNG'sindeki piksel indeksine çevirir.
 * Y ekseni görüntüde ters olduğu için imageHeight ile çevrilir.
 */
export function worldToOccupancyPixel(worldX, worldY, metadata, imageHeight) {
  const pixelX = (worldX - metadata.origin[0]) / metadata.resolution;
  const pixelY = imageHeight - (worldY - metadata.origin[1]) / metadata.resolution;
  return { x: pixelX, y: pixelY };
}

/** Belirtilen pikselin RGBA değerlerini okur; sınır dışındaysa outOfBounds: true döner. */
export function getOccupancyPixelRgba(imageData, pixelX, pixelY, imageWidth, imageHeight) {
  const ix = Math.floor(pixelX);
  const iy = Math.floor(pixelY);
  if (ix < 0 || ix >= imageWidth || iy < 0 || iy >= imageHeight) {
    return { r: 0, g: 0, b: 0, a: 0, outOfBounds: true, grayscale: 0 };
  }

  const offset = (iy * imageWidth + ix) * 4;  // her piksel 4 byte: R,G,B,A
  const r = imageData.data[offset];
  const g = imageData.data[offset + 1];
  const b = imageData.data[offset + 2];
  const a = imageData.data[offset + 3];

  return {
    r,
    g,
    b,
    a,
    outOfBounds: false,
    grayscale: r,  // occupancy PNG gri tonlu; R kanalı yeterli
  };
}

/** Pikselin gri tonunu döner (geçilebilirlik karşılaştırması için). */
export function getOccupancyPixelValue(imageData, pixelX, pixelY, imageWidth, imageHeight) {
  return getOccupancyPixelRgba(imageData, pixelX, pixelY, imageWidth, imageHeight).grayscale;
}

/** Piksel eşiğinin üstündeyse geçilebilir sayılır (beyaz/açık alan). */
export function isOccupancyPixelPassable(imageData, pixelX, pixelY, imageWidth, imageHeight) {
  if (!imageData) return false;
  const sample = getOccupancyPixelRgba(imageData, pixelX, pixelY, imageWidth, imageHeight);
  if (sample.outOfBounds) return false;
  return sample.grayscale > FREE_SPACE_THRESHOLD;
}

/**
 * Dünya koordinatında hedefin üç katmanlı geçilebilirlik kontrolü.
 * 1) Harita pikseli engel mi?  2) Geofence dışında mı?  3) Yasak dikdörtgende mi?
 * Erken return: ucuz piksel kontrolü önce; poligon/yasak sadece piksel geçtiyse.
 */
export function isWorldGoalPassable(
  worldX,
  worldY,
  metadata,
  imageSize,
  imageData,
  forbiddenZones = null,
  boundaryPolygon = null,
) {
  if (!metadata || !imageData || !imageSize) return false;

  const { x, y } = worldToOccupancyPixel(worldX, worldY, metadata, imageSize.height);

  if (x < 0 || x >= imageSize.width || y < 0 || y >= imageSize.height) {
    return false;
  }

  if (!isOccupancyPixelPassable(
    imageData,
    x,
    y,
    imageSize.width,
    imageSize.height,
  )) {
    return false;
  }

  if (boundaryPolygon && boundaryPolygon.length >= 3) {
    // Harita sınırı düzensiz şekilli olabildiği için dikdörtgen değil poligon kontrolü yapılır.
    if (!isPointInPolygon(worldX, worldY, boundaryPolygon)) {
      return false;
    }
  }

  if (isPointInForbiddenZone(worldX, worldY, forbiddenZones)) {
    return false;
  }

  return true;
}

/** Operatör panelinde geçersiz hedef popup'ında gösterilen sabit mesaj. */
export const INVALID_GOAL_MESSAGE =
  'Bu nokta geçilebilir alan dışında, lütfen açık bölgeye hedef seçin';
