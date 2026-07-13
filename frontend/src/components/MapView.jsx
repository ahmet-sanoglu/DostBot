import React, { useEffect, useRef, useState } from 'react';
import { Topic } from 'roslib';
import { useRos } from '../context/RosContext';
import { useTelemetry } from '../context/TelemetryContext';

// Flask API uç noktaları
const MAP_METADATA_URL = 'http://localhost:5000/api/map/metadata';
const MAP_IMAGE_URL = 'http://localhost:5000/api/map/image';
const ODOMETRY_TOPIC = '/odometry/filtered_uwb';
const TRAIL_MAX = 200;
const TRAIL_MIN_DIST_M = 0.05;
const FREE_SPACE_THRESHOLD = 250;
const MAP_THEME = {
  free: { r: 0xe8, g: 0xec, b: 0xf1, a: 255 },
  obstacle: { r: 0x1e, g: 0x2a, b: 0x3a, a: 255 },
  unknown: { r: 0xb8, g: 0xc0, b: 0xcc, a: 128 },
};
const POS_SMOOTH_ALPHA = 0.35;
const YAW_SMOOTH_ALPHA = 0.25;
// Harita 90° saat yönünde döndürülerek yatay (landscape) gösterilir
const MAP_ROTATION = Math.PI / 2;

/**
 * 90° döndürülmüş haritanın canvas'a sığması için ölçek ve merkez ofseti.
 * Döndürme sonrası görünen boyut: yükseklik × genişlik (W×H → H×W).
 */
function getMapFitTransform(imageObj, canvasWidth, canvasHeight) {
  const mapDisplayW = imageObj.height;
  const mapDisplayH = imageObj.width;
  const fitScale = Math.min(canvasWidth / mapDisplayW, canvasHeight / mapDisplayH);
  const centerX = (canvasWidth - mapDisplayW * fitScale) / 2;
  const centerY = (canvasHeight - mapDisplayH * fitScale) / 2;
  return { fitScale, centerX, centerY };
}

/** Ham occupancy piksellerini dashboard temasına göre renklendirir. */
function buildThemedMapImage(sourceImage) {
  const canvas = document.createElement('canvas');
  canvas.width = sourceImage.width;
  canvas.height = sourceImage.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceImage, 0, 0);

  const rawData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const themedData = ctx.createImageData(canvas.width, canvas.height);

  for (let i = 0; i < rawData.data.length; i += 4) {
    const value = rawData.data[i];
    let color;
    if (value > FREE_SPACE_THRESHOLD) {
      color = MAP_THEME.free;
    } else if (value < 10) {
      color = MAP_THEME.obstacle;
    } else {
      color = MAP_THEME.unknown;
    }

    themedData.data[i] = color.r;
    themedData.data[i + 1] = color.g;
    themedData.data[i + 2] = color.b;
    themedData.data[i + 3] = color.a;
  }

  ctx.putImageData(themedData, 0, 0);
  return { rawData, themedCanvas: canvas };
}

/**
 * Quaternion'dan Z ekseni etrafındaki yaw açısını (radyan) hesaplar.
 */
function quaternionToYaw(x, y, z, w) {
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

/**
 * ROS dünya koordinatını orijinal (döndürülmemiş) harita piksel koordinatına çevirir.
 * Harita döndürmesi canvas transform'unda uygulanır; bu fonksiyon sadece resolution/origin kullanır.
 */
function worldToPixel(worldX, worldY, metadata, imageHeight) {
  const pixelX = (worldX - metadata.origin[0]) / metadata.resolution;
  const pixelY = imageHeight - (worldY - metadata.origin[1]) / metadata.resolution;

  return { x: pixelX, y: pixelY };
}

function imagePixelToWorld(pixelX, pixelY, metadata, imageHeight) {
  const worldX = pixelX * metadata.resolution + metadata.origin[0];
  const worldY = (imageHeight - pixelY) * metadata.resolution + metadata.origin[1];
  return { x: worldX, y: worldY };
}

/** Canvas tıklamasını orijinal harita piksel koordinatına çevirir. */
function canvasToImagePixel(canvasX, canvasY, imageObj, fitScale, centerX, centerY, scale, offset) {
  let sx = (canvasX - offset.x) / scale;
  let sy = (canvasY - offset.y) / scale;
  const rx = (sx - centerX) / fitScale;
  const ry = (sy - centerY) / fitScale;
  const iy = -rx;
  const ix = ry - imageObj.height;
  return { x: ix, y: iy };
}

function getPixelValue(imageData, x, y, imageWidth, imageHeight) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || ix >= imageWidth || iy < 0 || iy >= imageHeight) {
    return 0;
  }
  return imageData.data[(iy * imageWidth + ix) * 4];
}

function isFreePixel(imageData, x, y, imageWidth, imageHeight) {
  return getPixelValue(imageData, x, y, imageWidth, imageHeight) > FREE_SPACE_THRESHOLD;
}

/**
 * Gri/siyah pikseldeyse en yakın geçilebilir (beyaz) piksele snap eder.
 * Zaten beyazsa koordinatı değiştirmez — gereksiz sıçramayı önler.
 */
function snapToFreePixel(imageData, targetX, targetY, imageWidth, imageHeight) {
  if (isFreePixel(imageData, targetX, targetY, imageWidth, imageHeight)) {
    return { x: targetX, y: targetY };
  }

  const originX = Math.round(targetX);
  const originY = Math.round(targetY);

  for (let radius = 5; radius <= 100; radius += 5) {
    let bestDist = Infinity;
    let best = null;

    for (let dy = -radius; dy <= radius; dy += 3) {
      for (let dx = -radius; dx <= radius; dx += 3) {
        const cheb = Math.max(Math.abs(dx), Math.abs(dy));
        if (cheb < radius - 4 || cheb > radius) continue;

        const nx = originX + dx;
        const ny = originY + dy;
        if (!isFreePixel(imageData, nx, ny, imageWidth, imageHeight)) continue;

        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = { x: nx, y: ny };
        }
      }
    }

    if (best) return best;
  }

  return { x: targetX, y: targetY };
}

function worldToDisplayPixel(worldX, worldY, mapMeta, imageObj, imageData) {
  const { x, y } = worldToPixel(worldX, worldY, mapMeta, imageObj.height);
  const clampedX = Math.max(0, Math.min(imageObj.width - 1, x));
  const clampedY = Math.max(0, Math.min(imageObj.height - 1, y));

  if (!imageData) {
    return { x: clampedX, y: clampedY };
  }

  return snapToFreePixel(
    imageData,
    clampedX,
    clampedY,
    imageObj.width,
    imageObj.height,
  );
}

/** Açıyı [-π, +π] aralığına sarar. */
function normalizeAngle(angle) {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** İki açı arasındaki en kısa fark (a - b), ±π içinde. */
function angleDifference(a, b) {
  let diff = a - b;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
}

/** Odometri gürültüsünü azaltmak için üstel yumuşatma (EMA) + yaw sarmalama. */
function smoothPose(raw, prev) {
  if (!prev) {
    return {
      x: raw.x,
      y: raw.y,
      yaw: normalizeAngle(raw.yaw),
    };
  }

  const prevYaw = normalizeAngle(prev.yaw);
  let smoothedYaw = prevYaw + angleDifference(raw.yaw, prevYaw) * YAW_SMOOTH_ALPHA;
  smoothedYaw = normalizeAngle(smoothedYaw);

  return {
    x: prev.x + POS_SMOOTH_ALPHA * (raw.x - prev.x),
    y: prev.y + POS_SMOOTH_ALPHA * (raw.y - prev.y),
    yaw: smoothedYaw,
  };
}

/**
 * ROS yaw'ını harita piksel uzayındaki canvas rotasyon açısına çevirir.
 * Harita döndürmesi üst transform'da uygulandığı için burada sadece -yaw (Y ters) yeterli.
 */
function robotRotationAngle(yaw) {
  return -yaw;
}

/**
 * Robot konumunda yaw yönünü gösteren turuncu üçgen ok çizer.
 * Üçgen varsayılan olarak SAĞA (+X) bakar; ctx.rotate ile yönlendirilir.
 */
function drawRobotArrow(ctx, x, y, yaw, scale) {
  const size = 14 / scale;
  const rotationAngle = robotRotationAngle(yaw);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotationAngle);

  // Hafif gölge
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 4 / scale;
  ctx.shadowOffsetX = 1 / scale;
  ctx.shadowOffsetY = 1 / scale;

  // Sağa bakan üçgen: sivri uç +X'te, taban solda, merkez (0,0)
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.65, size * 0.6);
  ctx.lineTo(-size * 0.65, -size * 0.6);
  ctx.closePath();

  ctx.fillStyle = '#ff6b00';
  ctx.fill();
  ctx.strokeStyle = '#b83200';
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  ctx.restore();
}

/** Otonom modda seçilen hedefi harita üzerinde işaretler. */
function drawGoalMarker(ctx, x, y, scale) {
  const radius = 10 / scale;

  ctx.save();
  ctx.shadowColor = 'rgba(99, 102, 241, 0.55)';
  ctx.shadowBlur = 8 / scale;

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(99, 102, 241, 0.35)';
  ctx.fill();
  ctx.strokeStyle = '#818cf8';
  ctx.lineWidth = 2 / scale;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + radius * 1.4, y);
  ctx.strokeStyle = '#c7d2fe';
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  ctx.restore();
}

/** Robot hareket izini yarı saydam gri noktalar olarak çizer (robot ikonunun altında). */
function drawPositionTrail(ctx, trail, mapMeta, imageObj, imageData, scale) {
  const dotRadius = 1.5 / scale;

  ctx.fillStyle = 'rgba(128, 128, 128, 0.4)';

  for (const point of trail) {
    const { x, y } = worldToDisplayPixel(
      point.x,
      point.y,
      mapMeta,
      imageObj,
      imageData,
    );

    ctx.beginPath();
    ctx.arc(x, y, dotRadius, 0, 2 * Math.PI);
    ctx.fill();
  }
}

const MapView = ({
  enableClickToGo = false,
  onMapGoalClick,
  goalMarker = null,
}) => {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);

  // Harita verisi
  const [mapMeta, setMapMeta] = useState(null);
  const [imageObj, setImageObj] = useState(null);
  const [themedImageObj, setThemedImageObj] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Robot konumu ve yönelimi (ROS dünya koordinatları)
  const [robotPose, setRobotPose] = useState(null);
  const [positionTrail, setPositionTrail] = useState([]);
  const mapImageDataRef = useRef(null);
  const smoothedPoseRef = useRef(null);
  const { setPose: setTelemetryPose } = useTelemetry();
  const { ros, status: rosStatus } = useRos();

  // Zoom ve pan durumu
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  // Canvas boyutu (ResizeObserver ile güncellenir)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // Sol tık sürükleme (pan) durumu — ref ile senkron takip (mouseup stale closure önlenir)
  const [isPanning, setIsPanning] = useState(false);
  const isPanningRef = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const panStartPos = useRef({ x: 0, y: 0 });
  const didPanRef = useRef(false);
  const interactionRef = useRef({});

  interactionRef.current = {
    enableClickToGo,
    mapMeta,
    imageObj,
    scale,
    offset,
    onMapGoalClick,
  };

  // ── 1. Flask'tan harita metadata ve görüntüsünü çek ──
  useEffect(() => {
    fetch(MAP_METADATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Metadata alınamadı (${res.status})`);
        return res.json();
      })
      .then((data) => setMapMeta(data))
      .catch((err) => {
        console.error('Harita metadata çekilemedi:', err);
        setLoadError('Harita metadata yüklenemedi.');
      });

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => setImageObj(img);
    img.onerror = () => {
      console.error('Harita görüntüsü yüklenemedi.');
      setLoadError('Harita görüntüsü yüklenemedi.');
    };
    img.src = MAP_IMAGE_URL;
  }, []);

  useEffect(() => {
    if (!imageObj) {
      mapImageDataRef.current = null;
      setThemedImageObj(null);
      return;
    }

    const { rawData, themedCanvas } = buildThemedMapImage(imageObj);
    mapImageDataRef.current = rawData;

    const themedImg = new Image();
    themedImg.onload = () => setThemedImageObj(themedImg);
    themedImg.src = themedCanvas.toDataURL();
  }, [imageObj]);

  // ── 2. Paylaşılan ROS bağlantısı üzerinden odometri topic'ini dinle ──
  useEffect(() => {
    if (!ros) return;

    const odomTopic = new Topic({
      ros,
      name: ODOMETRY_TOPIC,
      messageType: 'nav_msgs/Odometry',
    });

    odomTopic.subscribe((message) => {
      const { x, y } = message.pose.pose.position;
      const { x: qx, y: qy, z: qz, w: qw } = message.pose.pose.orientation;
      const rawPose = {
        x,
        y,
        yaw: quaternionToYaw(qx, qy, qz, qw),
      };
      const smoothed = smoothPose(rawPose, smoothedPoseRef.current);
      smoothedPoseRef.current = smoothed;
      setRobotPose(smoothed);

      setPositionTrail((prev) => {
        const last = prev[prev.length - 1];
        if (last) {
          const dx = smoothed.x - last.x;
          const dy = smoothed.y - last.y;
          if (dx * dx + dy * dy < TRAIL_MIN_DIST_M * TRAIL_MIN_DIST_M) {
            return prev;
          }
        }
        const next = [...prev, { x: smoothed.x, y: smoothed.y }];
        return next.length > TRAIL_MAX ? next.slice(-TRAIL_MAX) : next;
      });
    });

    return () => odomTopic.unsubscribe();
  }, [ros]);

  useEffect(() => {
    if (robotPose) {
      setTelemetryPose(robotPose);
    }
  }, [robotPose, setTelemetryPose]);

  // ── 4. ResizeObserver: container boyutu değişince canvas'ı güncelle ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setCanvasSize({
        width: Math.floor(width),
        height: Math.floor(height),
      });
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ── Canvas çizim fonksiyonu (harita + robot konumu) ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.width === 0 || !imageObj || !themedImageObj) return;

    // Canvas piksel boyutunu container'a eşitle
    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const { fitScale, centerX, centerY } = getMapFitTransform(
      imageObj,
      canvas.width,
      canvas.height,
    );
    const totalScale = scale * fitScale;

    // Kullanıcı zoom/pan + haritayı kapsayıcıya sığdırma
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);
    ctx.translate(centerX, centerY);
    ctx.scale(fitScale, fitScale);

    // Harita + robot: aynı döndürme transform'u içinde çizilir
    ctx.save();
    ctx.translate(imageObj.height, 0);
    ctx.rotate(MAP_ROTATION);
    ctx.drawImage(themedImageObj, 0, 0);

    if (mapMeta && positionTrail.length > 0) {
      drawPositionTrail(
        ctx,
        positionTrail,
        mapMeta,
        imageObj,
        mapImageDataRef.current,
        totalScale,
      );
    }

    if (robotPose && mapMeta) {
      const { x, y } = worldToDisplayPixel(
        robotPose.x,
        robotPose.y,
        mapMeta,
        imageObj,
        mapImageDataRef.current,
      );

      drawRobotArrow(ctx, x, y, robotPose.yaw, totalScale);
    }

    if (goalMarker && mapMeta) {
      const { x, y } = worldToDisplayPixel(
        goalMarker.x,
        goalMarker.y,
        mapMeta,
        imageObj,
        mapImageDataRef.current,
      );
      drawGoalMarker(ctx, x, y, totalScale);
    }

    ctx.restore();

    ctx.restore();
  }, [canvasSize, imageObj, themedImageObj, mapMeta, robotPose, positionTrail, scale, offset, goalMarker]);

  const scaleRef = useRef(scale);
  const offsetRef = useRef(offset);
  scaleRef.current = scale;
  offsetRef.current = offset;

  const handleWheelRef = useRef(null);
  handleWheelRef.current = (e) => {
    e.preventDefault();

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const currentScale = scaleRef.current;
    const currentOffset = offsetRef.current;

    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.min(10, Math.max(0.1, currentScale * zoomFactor));

    setOffset({
      x: mouseX - (mouseX - currentOffset.x) * (newScale / currentScale),
      y: mouseY - (mouseY - currentOffset.y) * (newScale / currentScale),
    });
    setScale(newScale);
  };

  // ── 3b. Sol tık basılı tutarak pan (kaydırma) + tıklama ──
  const finishPointerInteraction = (clientX, clientY) => {
    if (!isPanningRef.current) return;

    const {
      enableClickToGo: clickEnabled,
      mapMeta: meta,
      imageObj: img,
      scale: currentScale,
      offset: currentOffset,
      onMapGoalClick: onClick,
    } = interactionRef.current;

    if (clickEnabled && !didPanRef.current && meta && img && onClick) {
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const canvasX = clientX - rect.left;
        const canvasY = clientY - rect.top;
        const { fitScale, centerX, centerY } = getMapFitTransform(
          img,
          canvas.width,
          canvas.height,
        );
        const { x: pixelX, y: pixelY } = canvasToImagePixel(
          canvasX,
          canvasY,
          img,
          fitScale,
          centerX,
          centerY,
          currentScale,
          currentOffset,
        );

        if (
          pixelX >= 0 && pixelX < img.width
          && pixelY >= 0 && pixelY < img.height
        ) {
          const world = imagePixelToWorld(pixelX, pixelY, meta, img.height);
          onClick(world);
        }
      }
    }

    isPanningRef.current = false;
    setIsPanning(false);
  };

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    isPanningRef.current = true;
    setIsPanning(true);
    didPanRef.current = false;
    panStartPos.current = { x: e.clientX, y: e.clientY };
    lastMousePos.current = { x: e.clientX, y: e.clientY };

    const handleWindowMouseUp = (ev) => {
      window.removeEventListener('mouseup', handleWindowMouseUp);
      finishPointerInteraction(ev.clientX, ev.clientY);
    };
    window.addEventListener('mouseup', handleWindowMouseUp);
  };

  const handleMouseMove = (e) => {
    if (!isPanningRef.current) return;

    const dx = e.clientX - lastMousePos.current.x;
    const dy = e.clientY - lastMousePos.current.y;
    lastMousePos.current = { x: e.clientX, y: e.clientY };

    const totalDx = e.clientX - panStartPos.current.x;
    const totalDy = e.clientY - panStartPos.current.y;
    if (Math.hypot(totalDx, totalDy) > 4) {
      didPanRef.current = true;
    }

    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  };

  const handleMouseUp = (e) => {
    if (e.button !== 0) return;
    finishPointerInteraction(e.clientX, e.clientY);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e) => handleWheelRef.current?.(e);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="map-view-root">
      <h2 className="map-view-header">Gerçek Zamanlı Sera Haritası</h2>

      <div className="map-view-meta" style={{ marginBottom: '8px', fontSize: '14px', color: '#555' }}>
        {mapMeta && (
          <span>Çözünürlük: {mapMeta.resolution} m/px &nbsp;|&nbsp; </span>
        )}
        <span>ROS: {rosStatus}</span>
        {robotPose && (
          <span>
            &nbsp;|&nbsp; Robot: X={robotPose.x.toFixed(2)} m, Y={robotPose.y.toFixed(2)} m
            &nbsp;|&nbsp; Yaw={((normalizeAngle(robotPose.yaw) * 180) / Math.PI).toFixed(1)}°
          </span>
        )}
      </div>

      {loadError && (
        <p className="map-view-error">{loadError}</p>
      )}

      <div
        ref={containerRef}
        className={`map-view-canvas-wrap${isPanning ? ' is-panning' : ''}${enableClickToGo ? ' is-click-nav' : ''}`}
      >
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          className="map-view-canvas"
        />
      </div>

      <p className="map-view-footer" style={{ marginTop: '8px', fontSize: '13px', color: '#888' }}>
        Fare tekerleği: yakınlaştır/uzaklaştır &nbsp;|&nbsp; Sol tık + sürükle: haritayı kaydır
        {enableClickToGo && (
          <span>
            &nbsp;|&nbsp; Tek tık: hedef seç
          </span>
        )}
      </p>
    </div>
  );
};

export default MapView;
