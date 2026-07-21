// Mühendis panelinin backend'e yazma/silme istekleri — PIN korumalı endpoint'ler.
// PIN doğrulandıktan sonra sessionStorage'da saklanır; her istekte X-Admin-Pin başlığı gönderilir.
// Bu gerçek bir oturum sistemi değildir; yanlışlıkla veri değişikliğini engelleyen basit katmandır.

const API_BASE = 'http://localhost:5000';
export const ADMIN_PIN_STORAGE_KEY = 'adminPin';

/** fetch + JSON; hata gövdesindeki error alanını mesaj olarak kullanır. */
async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

/** Tarayıcı oturumunda saklanan mühendis PIN'ini okur (sekme kapanınca silinir). */
export function getStoredAdminPin() {
  return sessionStorage.getItem(ADMIN_PIN_STORAGE_KEY);
}

/** PIN doğrulandıktan sonra sessionStorage'a yazar. */
export function storeAdminPin(pin) {
  sessionStorage.setItem(ADMIN_PIN_STORAGE_KEY, pin);
}

/** Çıkış veya oturum sıfırlama için PIN'i sessionStorage'dan siler. */
export function clearStoredAdminPin() {
  sessionStorage.removeItem(ADMIN_PIN_STORAGE_KEY);
}

/** Backend'e PIN gönderir; doğruysa true, yanlışsa hata fırlatır. */
export async function verifyAdminPin(pin) {
  const res = await fetch(`${API_BASE}/api/admin/verify-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.valid) {
    return true;
  }
  throw new Error(data.error || 'Geçersiz PIN');
}

/** Yazma/silme isteklerinde kullanılan ortak başlıklar; X-Admin-Pin backend doğrulaması için. */
function adminHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Admin-Pin': getStoredAdminPin() || '',
    ...extra,
  };
}

/** Yeni konum ekler; backend otomatik tek adımlı görev de oluşturur. */
export async function createMapLocation(mapId, location) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/locations`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(location),
  });
}

/** PUT — konum güncellenince backend bağlı otomatik görevi de senkronize eder. */
export async function updateMapLocation(mapId, locationId, location) {
  return fetchJson(
    `${API_BASE}/api/maps/${encodeURIComponent(mapId)}/locations/${encodeURIComponent(locationId)}`,
    {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify(location),
    },
  );
}

/** Konumu siler; locationId ile bağlı otomatik görev backend'de de silinir. */
export async function deleteMapLocation(mapId, locationId) {
  return fetchJson(
    `${API_BASE}/api/maps/${encodeURIComponent(mapId)}/locations/${encodeURIComponent(locationId)}`,
    {
      method: 'DELETE',
      headers: adminHeaders(),
    },
  );
}

/** Çok adımlı rota görevi ekler (birden fazla konumu sırayla birleştirmek için). */
export async function createMapTask(mapId, task) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/tasks`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(task),
  });
}

/** PUT — mühendis panelinden görev düzenleme modalının kaydet akışı. */
export async function updateMapTask(mapId, taskId, task) {
  return fetchJson(
    `${API_BASE}/api/maps/${encodeURIComponent(mapId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify(task),
    },
  );
}

/** DELETE — mühendis panelinden görev silme; operatör listesinden de kalkar. */
export async function deleteMapTask(mapId, taskId) {
  return fetchJson(
    `${API_BASE}/api/maps/${encodeURIComponent(mapId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'DELETE',
      headers: adminHeaders(),
    },
  );
}

/** Mühendis panelinde çizilen geofence poligonunu kaydeder. */
export async function saveMapBoundary(mapId, points) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/boundary`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ points }),
  });
}

/** Geofence sınırını kaldırır. */
export async function deleteMapBoundary(mapId) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/boundary`, {
    method: 'DELETE',
    headers: adminHeaders(),
  });
}
