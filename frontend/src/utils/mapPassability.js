import { isPointInForbiddenZone } from './forbiddenZones';
import { isPointInPolygon } from './geofence';

/** 240: beyaz (~254) geçilebilir sayılır; gri (~205) ve siyah (~0) engel — arada güvenli marj bırakır. */
export const FREE_SPACE_THRESHOLD = 240;

export function worldToOccupancyPixel(worldX, worldY, metadata, imageHeight) {
  const pixelX = (worldX - metadata.origin[0]) / metadata.resolution;
  const pixelY = imageHeight - (worldY - metadata.origin[1]) / metadata.resolution;
  return { x: pixelX, y: pixelY };
}

export function getOccupancyPixelRgba(imageData, pixelX, pixelY, imageWidth, imageHeight) {
  const ix = Math.floor(pixelX);
  const iy = Math.floor(pixelY);
  if (ix < 0 || ix >= imageWidth || iy < 0 || iy >= imageHeight) {
    return { r: 0, g: 0, b: 0, a: 0, outOfBounds: true, grayscale: 0 };
  }

  const offset = (iy * imageWidth + ix) * 4;
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
    grayscale: r,
  };
}

export function getOccupancyPixelValue(imageData, pixelX, pixelY, imageWidth, imageHeight) {
  return getOccupancyPixelRgba(imageData, pixelX, pixelY, imageWidth, imageHeight).grayscale;
}

export function isOccupancyPixelPassable(imageData, pixelX, pixelY, imageWidth, imageHeight) {
  if (!imageData) return false;
  const sample = getOccupancyPixelRgba(imageData, pixelX, pixelY, imageWidth, imageHeight);
  if (sample.outOfBounds) return false;
  return sample.grayscale > FREE_SPACE_THRESHOLD;
}

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

export const INVALID_GOAL_MESSAGE =
  'Bu nokta geçilebilir alan dışında, lütfen açık bölgeye hedef seçin';
