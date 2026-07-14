import { useEffect, useState } from 'react';
import {
  fetchActiveMap,
  fetchMapBoundary,
  fetchMapForbiddenZones,
  fetchMapLocations,
  fetchMapTasks,
} from '../utils/mapApi';

export function useActiveMap() {
  const [activeMap, setActiveMap] = useState(null);
  const [locations, setLocations] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [forbiddenZones, setForbiddenZones] = useState([]);
  const [boundaryPolygon, setBoundaryPolygon] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const map = await fetchActiveMap();
        if (cancelled) return;

        const [mapLocations, mapTasks, mapForbiddenZones, mapBoundary] = await Promise.all([
          fetchMapLocations(map.id),
          fetchMapTasks(map.id),
          fetchMapForbiddenZones(map.id),
          fetchMapBoundary(map.id),
        ]);

        if (cancelled) return;

        setActiveMap(map);
        setLocations(Array.isArray(mapLocations) ? mapLocations : []);
        setTasks(Array.isArray(mapTasks) ? mapTasks : []);
        setForbiddenZones(Array.isArray(mapForbiddenZones) ? mapForbiddenZones : []);
        setBoundaryPolygon(mapBoundary);
      } catch (err) {
        if (!cancelled) {
          setActiveMap(null);
          setLocations([]);
          setTasks([]);
          setForbiddenZones([]);
          setBoundaryPolygon(null);
          setError(err.message || 'Harita verileri yüklenemedi.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  return {
    activeMap,
    locations,
    tasks,
    forbiddenZones,
    boundaryPolygon,
    loading,
    error,
  };
}
