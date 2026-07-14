const API_BASE = 'http://localhost:5000';
export const ADMIN_PIN_STORAGE_KEY = 'adminPin';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export function getStoredAdminPin() {
  return sessionStorage.getItem(ADMIN_PIN_STORAGE_KEY);
}

export function storeAdminPin(pin) {
  sessionStorage.setItem(ADMIN_PIN_STORAGE_KEY, pin);
}

export function clearStoredAdminPin() {
  sessionStorage.removeItem(ADMIN_PIN_STORAGE_KEY);
}

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

function adminHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Admin-Pin': getStoredAdminPin() || '',
    ...extra,
  };
}

export async function createMapLocation(mapId, location) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/locations`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(location),
  });
}

export async function deleteMapLocation(mapId, locationId) {
  return fetchJson(
    `${API_BASE}/api/maps/${encodeURIComponent(mapId)}/locations/${encodeURIComponent(locationId)}`,
    {
      method: 'DELETE',
      headers: adminHeaders(),
    },
  );
}

export async function createMapTask(mapId, task) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/tasks`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(task),
  });
}

export async function saveMapBoundary(mapId, points) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/boundary`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ points }),
  });
}

export async function deleteMapBoundary(mapId) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/boundary`, {
    method: 'DELETE',
    headers: adminHeaders(),
  });
}
