/** Ray-casting — tarla/harita sınırı serbest çizilebildiği için dikdörtgen yerine poligon kullanılır. */
export function isPointInPolygon(x, y, polygon) {
  if (!polygon || polygon.length < 3) return true;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);

    if (intersects) inside = !inside;
  }

  return inside;
}
