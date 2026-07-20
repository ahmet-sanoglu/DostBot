// Backend Flask API'den salt okunur (GET) harita verilerini çeker.
// Operatör ve mühendis paneli sayfa açılışında bu fonksiyonları kullanır; PIN gerekmez.

const API_BASE = 'http://localhost:5000';

/** fetch + JSON parse; HTTP hata kodunda exception fırlatır. */
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return res.json();
}

/** Aktif haritanın kimliğini ve adını döner (maps.json içinde isActive: true olan). */
export async function fetchActiveMap() {
  return fetchJson(`${API_BASE}/api/maps/active`);
}

/** Haritaya kayıtlı konum noktalarını listeler. */
export async function fetchMapLocations(mapId) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/locations`);
}

/** Operatör panelindeki görev listesini döner; eksik tek adımlı görevler backend'de tamamlanır. */
export async function fetchMapTasks(mapId) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/tasks`);
}

/** Dikdörtgen yasak bölgeleri döner (hedef geçilebilirlik kontrolünde kullanılır). */
export async function fetchMapForbiddenZones(mapId) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/forbidden-zones`);
}

/**
 * Geofence poligon noktalarını döner.
 * Sınır çizilmemişse null; en az 3 köşe yoksa geçersiz sayılıp null döner.
 */
export async function fetchMapBoundary(mapId) {
  const res = await fetch(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/boundary`);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  const data = await res.json();
  if (data === null) return null;
  const points = data?.points;
  return Array.isArray(points) && points.length >= 3 ? points : null;
}
