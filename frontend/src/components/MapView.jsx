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
  free: { r: 0xf0, g: 0xfd, b: 0xf4, a: 255 },
  obstacle: { r: 0x33, g: 0x41, b: 0x55, a: 255 },
  unknown: { r: 0xcb, g: 0xd5, b: 0xe1, a: 200 },
};
const POS_SMOOTH_ALPHA = 0.35;
const YAW_SMOOTH_ALPHA = 0.25;
// Harita 90° saat yönünde döndürülerek yatay (landscape) gösterilir
const MAP_ROTATION = Math.PI / 2;

/** Canlı/dinamik harita boyutları — imageObj değiştikçe tüm dönüşümler güncellenir. */
function getImageSize(imageObj) {
  return { width: imageObj.width, height: imageObj.height };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Ham occupancy piksel koordinatını [0, W)×[0, H) aralığına sıkıştırır. */
function clampImagePixel(pixelX, pixelY, imageSize) {
  const maxX = Math.max(0, imageSize.width - 1);
  const maxY = Math.max(0, imageSize.height - 1);
  return {
    x: clamp(pixelX, 0, maxX),
    y: clamp(pixelY, 0, maxY),
  };
}

function isImagePixelInBounds(pixelX, pixelY, imageSize, epsilon = 1e-4) {
  return (
    pixelX >= -epsilon
    && pixelX < imageSize.width - epsilon
    && pixelY >= -epsilon
    && pixelY < imageSize.height - epsilon
  );
}

/**
 * Döndürülmüş haritanın ekrandaki görünen boyutu: H × W piksel.
 *
 * Canvas iç transform (kod sırası): translate(0, W−1) → rotate(−π/2)
 * Noktaya uygulama sırası (API): önce rotate, sonra translate
 * → display-local: (iy, W−1−ix), her iki eksen [0, H) × [0, W)
 */
function getMapFitTransform(imageSize, canvasWidth, canvasHeight) {
  const displayW = imageSize.height;
  const displayH = imageSize.width;

  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return { fitScale: 1, centerX: 0, centerY: 0 };
  }

  const fitScale = Math.min(canvasWidth / displayW, canvasHeight / displayH);
  const centerX = (canvasWidth - displayW * fitScale) / 2;
  const centerY = (canvasHeight - displayH * fitScale) / 2;

  return { fitScale, centerX, centerY };
}

/** Çizim + tıklama için birleşik layout (canvas gerçek piksel boyutları). */
function getMapViewLayout(imageObj, canvasWidth, canvasHeight) {
  const imageSize = getImageSize(imageObj);
  return {
    imageSize,
    ...getMapFitTransform(imageSize, canvasWidth, canvasHeight),
  };
}

/**
 * İleri: image (ix, iy) → display-local (iy, W−1−ix).
 * canvasToImagePixel ile birebir terslenebilir.
 */
function imagePixelToDisplayLocal(pixelX, pixelY, imageSize) {
  return {
    x: pixelY,
    y: imageSize.width - 1 - pixelX,
  };
}

/** Display-local → image (ix, iy). */
function displayLocalToImagePixel(localX, localY, imageSize) {
  return {
    x: imageSize.width - 1 - localY,
    y: localX,
  };
}

/**
 * İleri: image → canvas.
 * offset → userScale → center → fitScale → display-local
 */
function imagePixelToCanvas(
  pixelX,
  pixelY,
  imageSize,
  fitScale,
  centerX,
  centerY,
  userScale,
  offset,
) {
  const { x: localX, y: localY } = imagePixelToDisplayLocal(pixelX, pixelY, imageSize);
  const viewX = centerX + fitScale * localX;
  const viewY = centerY + fitScale * localY;
  return {
    x: offset.x + userScale * viewX,
    y: offset.y + userScale * viewY,
  };
}

/** Ters: canvas → image (imagePixelToCanvas ile ters). */
function canvasToImagePixel(
  canvasX,
  canvasY,
  imageSize,
  fitScale,
  centerX,
  centerY,
  userScale,
  offset,
) {
  const viewX = (canvasX - offset.x) / userScale;
  const viewY = (canvasY - offset.y) / userScale;
  const localX = (viewX - centerX) / fitScale;
  const localY = (viewY - centerY) / fitScale;
  return displayLocalToImagePixel(localX, localY, imageSize);
}

/** clientX/Y → canvas iç piksel (CSS boyutu ≠ canvas.width ise ölçeklenir). */
function clientToCanvasPixel(clientX, clientY, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

/**
 * ROS dünya (m) → ham occupancy pikseli (döndürme öncesi).
 * Y ekseni: dünya ↑ = piksel ↓ (standart nav_msgs/OccupancyGrid).
 */
function worldToPixel(worldX, worldY, metadata, imageSize) {
  const pixelX = (worldX - metadata.origin[0]) / metadata.resolution;
  const pixelY = imageSize.height - (worldY - metadata.origin[1]) / metadata.resolution;
  return { x: pixelX, y: pixelY };
}

/** Ham occupancy pikseli → ROS dünya (m). worldToPixel ile terslenebilir. */
function imagePixelToWorld(pixelX, pixelY, metadata, imageSize) {
  const worldX = pixelX * metadata.resolution + metadata.origin[0];
  const worldY = (imageSize.height - pixelY) * metadata.resolution + metadata.origin[1];
  return { x: worldX, y: worldY };
}

/** Dünya koordinatını harita sınırları içinde tutar (köşe piksellerine clamp). */
function clampWorldToMapBounds(worldX, worldY, metadata, imageSize) {
  const pixel = worldToPixel(worldX, worldY, metadata, imageSize);
  const clamped = clampImagePixel(pixel.x, pixel.y, imageSize);
  return imagePixelToWorld(clamped.x, clamped.y, metadata, imageSize);
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
 * Hedef önce harita sınırlarına clamp edilir — arama asla dışarı taşmaz.
 */
function snapToFreePixel(imageData, targetX, targetY, imageWidth, imageHeight) {
  const clampedX = clamp(targetX, 0, Math.max(0, imageWidth - 1));
  const clampedY = clamp(targetY, 0, Math.max(0, imageHeight - 1));

  if (isFreePixel(imageData, clampedX, clampedY, imageWidth, imageHeight)) {
    return { x: clampedX, y: clampedY };
  }

  const originX = Math.round(clampedX);
  const originY = Math.round(clampedY);

  for (let radius = 5; radius <= 100; radius += 5) {
    let bestDist = Infinity;
    let best = null;

    for (let dy = -radius; dy <= radius; dy += 3) {
      for (let dx = -radius; dx <= radius; dx += 3) {
        const cheb = Math.max(Math.abs(dx), Math.abs(dy));
        if (cheb < radius - 4 || cheb > radius) continue;

        const nx = originX + dx;
        const ny = originY + dy;
        if (nx < 0 || nx >= imageWidth || ny < 0 || ny >= imageHeight) continue;
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

  return { x: clampedX, y: clampedY };
}

function worldToDisplayPixel(worldX, worldY, mapMeta, imageObj, imageData) {
  const imageSize = getImageSize(imageObj);
  const pixel = worldToPixel(worldX, worldY, mapMeta, imageSize);
  const clamped = clampImagePixel(pixel.x, pixel.y, imageSize);

  if (!imageData) {
    return clamped;
  }

  return snapToFreePixel(
    imageData,
    clamped.x,
    clamped.y,
    imageSize.width,
    imageSize.height,
  );
}

/**
 * Canvas tıklamasını harita sınırları + snap ile dünya koordinatına çevirir.
 * Sınır dışı tıklamalarda null döner.
 */
function canvasToWorldGoal(
  canvasX,
  canvasY,
  imageObj,
  metadata,
  imageData,
  fitScale,
  centerX,
  centerY,
  userScale,
  offset,
) {
  const imageSize = getImageSize(imageObj);

  const raw = canvasToImagePixel(
    canvasX,
    canvasY,
    imageSize,
    fitScale,
    centerX,
    centerY,
    userScale,
    offset,
  );

  if (!isImagePixelInBounds(raw.x, raw.y, imageSize)) {
    return null;
  }

  const clamped = clampImagePixel(raw.x, raw.y, imageSize);
  const snapped = imageData
    ? snapToFreePixel(
      imageData,
      clamped.x,
      clamped.y,
      imageSize.width,
      imageSize.height,
    )
    : clamped;

  const world = imagePixelToWorld(snapped.x, snapped.y, metadata, imageSize);
  return clampWorldToMapBounds(world.x, world.y, metadata, imageSize);
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

  ctx.fillStyle = '#06A89B';
  ctx.fill();
  ctx.strokeStyle = '#025539';
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  ctx.restore();
}

/** Otonom modda seçilen hedefi harita üzerinde işaretler. */
function drawGoalMarker(ctx, x, y, scale) {
  const radius = 10 / scale;

  ctx.save();
  ctx.shadowColor = 'rgba(6, 168, 155, 0.45)';
  ctx.shadowBlur = 8 / scale;

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(6, 168, 155, 0.25)';
  ctx.fill();
  ctx.strokeStyle = '#06A89B';
  ctx.lineWidth = 2 / scale;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + radius * 1.4, y);
  ctx.strokeStyle = 'rgba(6, 168, 155, 0.55)';
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  ctx.restore();
}

/** Robot hareket izini yarı saydam gri noktalar olarak çizer (robot ikonunun altında). */
function drawPositionTrail(ctx, trail, mapMeta, imageObj, imageData, scale) {
  const dotRadius = 1.5 / scale;

  ctx.fillStyle = 'rgba(6, 168, 155, 0.35)';

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
  const layoutRef = useRef(null);
  const viewResetKeyRef = useRef('');

  interactionRef.current = {
    enableClickToGo,
    clickEnabled: enableClickToGo,
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

  // Harita veya canvas boyutu değişince zoom/pan sıfırla — ilk açılışta ortalanmış görünüm
  useEffect(() => {
    if (!imageObj || canvasSize.width === 0 || canvasSize.height === 0) return;
    const key = `${canvasSize.width}x${canvasSize.height}-${imageObj.width}x${imageObj.height}`;
    if (key === viewResetKeyRef.current) return;
    viewResetKeyRef.current = key;
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [canvasSize.width, canvasSize.height, imageObj]);

  // ── Canvas çizim fonksiyonu (harita + robot konumu) ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.width === 0 || !imageObj || !themedImageObj) return;

    // Canvas piksel boyutunu container'a eşitle
    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const layout = getMapViewLayout(imageObj, canvas.width, canvas.height);
    const { imageSize, fitScale, centerX, centerY } = layout;
    const totalScale = scale * fitScale;

    layoutRef.current = layout;

    // Kullanıcı zoom/pan + haritayı kapsayıcıya sığdırma
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);
    ctx.translate(centerX, centerY);
    ctx.scale(fitScale, fitScale);

    // translate → rotate(−π/2): noktaya önce rotate, sonra translate(0,W−1) → (iy, W−1−ix)
    ctx.save();
    ctx.translate(0, imageSize.width - 1);
    ctx.rotate(-MAP_ROTATION);
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

    const { x: mouseX, y: mouseY } = clientToCanvasPixel(e.clientX, e.clientY, canvas);
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
        const { x: canvasX, y: canvasY } = clientToCanvasPixel(clientX, clientY, canvas);
        const layout = layoutRef.current
          ?? getMapViewLayout(img, canvas.width, canvas.height);
        const { fitScale, centerX, centerY } = layout;
        const result = canvasToWorldGoal(
          canvasX,
          canvasY,
          img,
          meta,
          mapImageDataRef.current,
          fitScale,
          centerX,
          centerY,
          currentScale,
          currentOffset,
        );

        if (result) {
          onClick(result);
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

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const dx = (e.clientX - lastMousePos.current.x) * scaleX;
    const dy = (e.clientY - lastMousePos.current.y) * scaleY;
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

      <div className="map-view-meta">
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

      <p className="map-view-footer">
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
