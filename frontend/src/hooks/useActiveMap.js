// Backend'den aktif harita ve ona bağlı tüm verileri (konum, görev, sınır, yasak bölge) yükler.
// Operatör ve mühendis paneli sayfa açıldığında bu hook ile harita verisini alır.
// Tek bir useEffect içinde paralel istekler atılır; sonuç state'e yazılır.

import { useEffect, useState } from 'react';
import {
  fetchActiveMap,
  fetchMapBoundary,
  fetchMapForbiddenZones,
  fetchMapLocations,
  fetchMapTasks,
} from '../utils/mapApi';

/**
 * Aktif harita kimliğini ve ilgili JSON verilerini backend API'den çeker.
 * loading/error bayrakları ile arayüzde yükleme ve hata durumu gösterilir.
 */
export function useActiveMap() {
  const [activeMap, setActiveMap] = useState(null);
  const [locations, setLocations] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [forbiddenZones, setForbiddenZones] = useState([]);
  const [boundaryPolygon, setBoundaryPolygon] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // useEffect: bileşen mount olduğunda bir kez veri yükler; unmount'ta iptal bayrağı koyar.
  useEffect(() => {
    let cancelled = false;  // hızlı sayfa değişiminde eski istek sonucu state'e yazılmasın

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const map = await fetchActiveMap();
        if (cancelled) return;

        // Promise.all: dört isteği paralel atar; hepsi bitince tek seferde state güncellenir.
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
