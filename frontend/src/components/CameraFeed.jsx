// Kamera görüntüsü — CAMERA_MODE'a göre sim (web_video_server) veya real (Flask RTSP proxy).
// Neden ayrı bileşen? Kontrol + mühendis paneli aynı fallback'i paylaşsın.
// onError: 503/bağlantı yok → fallback kutu; src='' ile tarayıcı yeniden denemesin.
// image_relay.py kaldırıldı (donma); sim için web_video_server :8080 kullanılıyor.
// onFrameAspect: ilk kare naturalWidth/Height → parent aspect-ratio (siyah bar azaltma).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCameraMode } from '../utils/mapApi';

export const CAMERA_REAL_STREAM_URL = 'http://localhost:5000/api/camera/stream';
/** web_video_server MJPEG — /camera/image_raw konusu. */
export const CAMERA_SIM_STREAM_URL =
  'http://localhost:8080/stream?topic=/camera/image_raw';

/** @deprecated — gerçek kamera; CAMERA_MODE=real iken kullanılır. */
export const CAMERA_STREAM_URL = CAMERA_REAL_STREAM_URL;

/** TurtleBot3 waffle_pi / tipik sim varsayılanı — onLoad gelene kadar. */
export const CAMERA_DEFAULT_ASPECT = 16 / 9;

/**
 * @param {object} props
 * @param {string} [props.className] — dış kutu
 * @param {string} [props.imgClassName] — <img>
 * @param {(info: { aspect: number, width: number, height: number }) => void} [props.onFrameAspect]
 *   İlk geçerli kare boyutu; sim/real oran farkında container'ı hizalamak için.
 */
export default function CameraFeed({ className = '', imgClassName = '', onFrameAspect }) {
  const [streamUrl, setStreamUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const lastAspectRef = useRef(null);
  const onFrameAspectRef = useRef(onFrameAspect);
  onFrameAspectRef.current = onFrameAspect;

  const reportAspect = useCallback((img) => {
    if (!img) return;
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!(width > 0 && height > 0)) return;
    const aspect = width / height;
    // Aynı oranı tekrar bildirme (MJPEG yeniden decode gürültüsü)
    if (lastAspectRef.current != null && Math.abs(lastAspectRef.current - aspect) < 0.001) {
      return;
    }
    lastAspectRef.current = aspect;
    onFrameAspectRef.current?.({ aspect, width, height });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setStreamUrl(null);
    lastAspectRef.current = null;

    (async () => {
      try {
        const data = await fetchCameraMode();
        const mode = String(data?.mode || 'real').toLowerCase();
        const url = mode === 'sim' ? CAMERA_SIM_STREAM_URL : CAMERA_REAL_STREAM_URL;
        if (!cancelled) setStreamUrl(url);
      } catch {
        // Mode okunamazsa gerçek kamera varsayılanı (eski davranış)
        if (!cancelled) setStreamUrl(CAMERA_REAL_STREAM_URL);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Hata sonrası <img> unmount — yeni istek döngüsü oluşmasın
  if (failed) {
    return (
      <div className={`camera-feed camera-feed--offline ${className}`.trim()} role="status">
        📷 Kamera bağlantısı yok
      </div>
    );
  }

  // Mode gelene kadar boş kutu — yanlış URL'ye kısa flash olmasın
  if (!streamUrl) {
    return (
      <div className={`camera-feed ${className}`.trim()} aria-busy="true" />
    );
  }

  return (
    <div className={`camera-feed ${className}`.trim()}>
      <img
        src={streamUrl}
        alt="Kamera akışı"
        className={`camera-feed__img ${imgClassName}`.trim()}
        onLoad={(event) => reportAspect(event.currentTarget)}
        onError={(event) => {
          // src boşalt: tarayıcı aynı URL'ye otomatik retry yapmasın
          event.target.src = '';
          setFailed(true);
        }}
      />
    </div>
  );
}
