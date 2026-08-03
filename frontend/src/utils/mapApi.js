// Backend Flask API'den salt okunur (GET) harita verilerini çeker.
// Operatör ve mühendis paneli sayfa açılışında bu fonksiyonları kullanır; PIN gerekmez.

const API_BASE = 'http://localhost:5000';

/** fetch + JSON parse; HTTP hata kodunda exception fırlatır. */
async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

/** Aktif haritanın kimliğini ve adını döner (maps.json içinde isActive: true olan). */
export async function fetchActiveMap() {
  return fetchJson(`${API_BASE}/api/maps/active`);
}

/** Kamera kaynağı: { mode: 'sim' | 'real' }.
 * Neden endpoint? CAMERA_MODE yalnızca sunucu .env'de; tarayıcıya URL hardcode etmeyelim.
 */
export async function fetchCameraMode() {
  return fetchJson(`${API_BASE}/api/camera/mode`);
}

/** Tüm harita kayıtlarını listeler (aktif + pasif) — mühendis paneli seçici için. */
export async function fetchMaps() {
  return fetchJson(`${API_BASE}/api/maps`);
}

/** Operatör panelindeki görev listesini döner. */
export async function fetchMapTasks(mapId) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/tasks`);
}

/** Görev geçmişi — birleşik run listesi (GET).
 * Neden birleşik? Ham başlatıldı/başarılı satırları UI'da tek kart olarak gösterilsin.
 */
export async function fetchMapTaskHistory(mapId) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/task-history`);
}

/**
 * Navigasyon yan kaydı POST — accepted/result sonrası.
 * Gövde: { taskName, status, timestamp, runId? } — runId başlatıldı+terminal'i bağlar.
 * Neden mapApi'de? NavigationContext await etmeden çağırır; nav state'e karışmaz.
 */
export async function appendMapTaskHistory(mapId, entry) {
  return fetchJson(
    `${API_BASE}/api/maps/${encodeURIComponent(mapId)}/task-history`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    },
  );
}

/**
 * Görev güncelleme (PUT) — operatör pin toggle için (PIN yok, içerik aynı kalmalı).
 * Mühendis tam düzenleme adminApi.updateMapTask + PIN kullanır.
 */
export async function updateMapTask(mapId, taskId, task) {
  return fetchJson(
    `${API_BASE}/api/maps/${encodeURIComponent(mapId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
    },
  );
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
