// Geofence (izin verilen alan sınırı) poligonu içinde nokta kontrolü.
// Tarla/harita sınırı serbest çizildiği için dikdörtgen yerine çokgen kullanılır.

/**
 * Ray-casting (ışın atma) ile noktanın poligon içinde olup olmadığını bulur.
 * Mantık: Noktadan sağa doğru hayali bir ışın çek; poligon kenarlarını kaç kez kestiğine bak.
 * Tek sayı kesti → içeride, çift sayı → dışarıda (çit etrafında dolaşma analojisi).
 * Poligon yoksa veya 3'ten az köşe varsa sınır tanımsız kabul edilir → true (engelleme yok).
 */
export function isPointInPolygon(x, y, polygon) {
  if (!polygon || polygon.length < 3) return true;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    // Kenar (i→j) yatay ışını kesiyor mu? Her kesimde inside bayrağını tersine çevir.
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);

    if (intersects) inside = !inside;
  }

  return inside;
}
