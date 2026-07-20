// Harita PNG'sini belleğe yükleyip "bu nokta geçilebilir mi?" sorusunu yanıtlar.
// Operatör görev başlatmadan önce hedefin duvar/engel/yasak bölge dışında olduğunu doğrular.
// Piksel rengi + geofence poligonu + yasak dikdörtgen sırayla kontrol edilir.

import { useCallback, useEffect, useRef, useState } from 'react';
import { isWorldGoalPassable } from '../utils/mapPassability';

const MAP_METADATA_URL = 'http://localhost:5000/api/map/metadata';
const MAP_IMAGE_URL = 'http://localhost:5000/api/map/image';

/**
 * Harita metadata (çözünürlük, orijin) ve occupancy PNG'sini yükler.
 * isGoalPassable(worldX, worldY) ile hedef noktanın güvenli olup olmadığını sorgular.
 */
export function useMapOccupancy(forbiddenZones = null, boundaryPolygon = null) {
  const [mapMeta, setMapMeta] = useState(null);
  const [imageSize, setImageSize] = useState(null);
  // useRef: büyük piksel dizisini state'te tutmaz; render tetiklemeden saklar (performans).
  const imageDataRef = useRef(null);
  const [ready, setReady] = useState(false);

  // forbidden/boundary props değişince ref güncellenir; isGoalPassable her zaman güncel değeri okur.
  const forbiddenRef = useRef(forbiddenZones);
  const boundaryRef = useRef(boundaryPolygon);
  forbiddenRef.current = forbiddenZones;
  boundaryRef.current = boundaryPolygon;

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch(MAP_METADATA_URL).then((res) => {
        if (!res.ok) throw new Error('metadata');
        return res.json();
      }),
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image'));
        img.src = MAP_IMAGE_URL;
      }),
    ])
      .then(([metadata, img]) => {
        if (cancelled) return;

        // PNG'yi canvas'a çizip piksel dizisini al — her hedef kontrolünde yeniden indirilmez.
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        imageDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
        setMapMeta(metadata);
        setImageSize({ width: img.width, height: img.height });
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          imageDataRef.current = null;
          setReady(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // useCallback: fonksiyon referansını sabit tutar — aksi halde ControlPanel effect'leri sonsuz render döngüsüne girer.
  const isGoalPassable = useCallback((worldX, worldY) => (
    isWorldGoalPassable(
      worldX,
      worldY,
      mapMeta,
      imageSize,
      imageDataRef.current,
      forbiddenRef.current,
      boundaryRef.current,
    )
  ), [mapMeta, imageSize, forbiddenZones, boundaryPolygon]);

  return { mapReady: ready, isGoalPassable };
}
