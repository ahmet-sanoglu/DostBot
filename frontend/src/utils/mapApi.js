const API_BASE = 'http://localhost:5000';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return res.json();
}

export async function fetchActiveMap() {
  return fetchJson(`${API_BASE}/api/maps/active`);
}

export async function fetchMapLocations(mapId) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/locations`);
}

export async function fetchMapTasks(mapId) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/tasks`);
}

export async function fetchMapForbiddenZones(mapId) {
  return fetchJson(`${API_BASE}/api/maps/${encodeURIComponent(mapId)}/forbidden-zones`);
}

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
