// RTSP→MJPEG kamera görüntüsü — Flask /api/camera/stream.
// Neden ayrı bileşen? Kontrol + mühendis paneli aynı fallback'i paylaşsın.
// onError: 503/bağlantı yok → fallback kutu; src='' ile tarayıcı yeniden denemesin
// (sekme "yükleniyor"da kalmasın). Joystick/nav akışına bağlanmaz.

import React, { useState } from 'react';

export const CAMERA_STREAM_URL = 'http://localhost:5000/api/camera/stream';

/**
 * @param {object} props
 * @param {string} [props.className] — dış kutu
 * @param {string} [props.imgClassName] — <img>
 */
export default function CameraFeed({ className = '', imgClassName = '' }) {
  const [failed, setFailed] = useState(false);

  // Hata sonrası <img> unmount — yeni istek döngüsü oluşmasın
  if (failed) {
    return (
      <div className={`camera-feed camera-feed--offline ${className}`.trim()} role="status">
        📷 Kamera bağlantısı yok
      </div>
    );
  }

  return (
    <div className={`camera-feed ${className}`.trim()}>
      <img
        src={CAMERA_STREAM_URL}
        alt="Kamera akışı"
        className={`camera-feed__img ${imgClassName}`.trim()}
        onError={(event) => {
          // src boşalt: tarayıcı aynı URL'ye otomatik retry yapmasın
          event.target.src = '';
          setFailed(true);
        }}
      />
    </div>
  );
}
