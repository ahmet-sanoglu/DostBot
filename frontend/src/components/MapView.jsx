// Operatör panelindeki canlı harita bileşeni.
// ROS odometrisinden robot konumunu alır, occupancy grid PNG'sini çizer, zoom/pan ve rota izi gösterir.
// Koordinat dönüşümleri birçok küçük fonksiyona bölündü — her biri tek bir adımı temsil eder (dünya↔piksel↔canvas).
// Nav2 /plan çizimi kaldırıldı — görev kalan adımları drawUpcomingRoute ile gösterilir (çift rota kafa karıştırmasın).
// Geçmiş iz kırmızı, gelecek rota yeşil: yönü renk ile ayırt etmek için; ikisi de aynı nokta tekniği
// (çizgi stili farkı "başka bir katman" gibi görünüp yoğunluğu bozmasın diye).

import React, { useEffect, useRef, useState } from 'react';
import { Topic } from 'roslib';
import { useRos } from '../context/RosContext';
import { useTelemetry } from '../context/TelemetryContext';
import { useNavigation } from '../context/NavigationContext';

import { FREE_SPACE_THRESHOLD, isOccupancyPixelPassable } from '../utils/mapPassability';
import {
  MAP_ROTATION,
  getImageSize,
  getMapFitTransform,
  worldToPixel,
  imagePixelToWorld,
  imagePixelToDisplayLocal,
  displayLocalToImagePixel,
  imagePixelToCanvas,
  canvasToImagePixel,
  clientToCanvasPixel,
  clamp,
  clampImagePixel,
  isImagePixelInBounds,
  clampWorldToMapBounds,
  quaternionToYaw,
  normalizeAngle,
  smoothPose,
} from '../utils/mapCoordinates';

const MAP_METADATA_URL = 'http://localhost:5000/api/map/metadata';
const MAP_IMAGE_URL = 'http://localhost:5000/api/map/image';
const ODOMETRY_TOPIC = '/odometry/filtered_uwb';
const TRAIL_MAX = 200;
const TRAIL_MIN_DIST_M = 0.05;
const MAP_THEME = {
  free: { r: 0xf0, g: 0xfd, b: 0xf4, a: 255 },
  obstacle: { r: 0x33, g: 0x41, b: 0x55, a: 255 },
  unknown: { r: 0xcb, g: 0xd5, b: 0xe1, a: 200 },
};

/** imageSize + fitScale + center — çizim ve tıklama için birleşik layout. */
function getMapViewLayout(imageObj, canvasWidth, canvasHeight) {
  const imageSize = getImageSize(imageObj);
  return {
    imageSize,
    ...getMapFitTransform(imageSize, canvasWidth, canvasHeight),
  };
}

/** Tek pikselin gri tonunu okur (geçilebilirlik karşılaştırması için). */
function getPixelValue(imageData, x, y, imageWidth, imageHeight) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || ix >= imageWidth || iy < 0 || iy >= imageHeight) {
    return 0;
  }
  return imageData.data[(iy * imageWidth + ix) * 4];
}

/** Piksel eşiğinin üstündeyse geçilebilir (beyaz/açık alan) sayılır. */
function isFreePixel(imageData, x, y, imageWidth, imageHeight) {
  return getPixelValue(imageData, x, y, imageWidth, imageHeight) > FREE_SPACE_THRESHOLD;
}

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

/**
 * Dünya → ekran pikseli; engeldeyse en yakın geçilebilir piksele snap eder.
 * Sadece iz / hedef önizlemesi için — robot ikonu snap kullanmaz (gerçek odometri konumu bozulmasın).
 */
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
 * Canvas tıklamasını önizleme için dünya koordinatına çevirir (snap yok).
 * Geçilebilirlik ham occupancy piksel değerine göre belirlenir.
 */
function canvasToWorldPreview(
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

  const inBounds = isImagePixelInBounds(raw.x, raw.y, imageSize);
  if (!inBounds) {
    return null;
  }

  const isPassable = imageData
    ? isOccupancyPixelPassable(
      imageData,
      raw.x,
      raw.y,
      imageSize.width,
      imageSize.height,
    )
    : false;

  const world = imagePixelToWorld(raw.x, raw.y, metadata, imageSize);
  return {
    x: world.x,
    y: world.y,
    isPassable,
  };
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

/** Otonom modda seçilen/geçici hedefi harita üzerinde işaretler. */
function drawGoalMarker(ctx, x, y, scale, isPassable = true) {
  const radius = 10 / scale;
  const isValid = isPassable !== false;

  ctx.save();
  ctx.shadowColor = isValid ? 'rgba(249, 115, 22, 0.45)' : 'rgba(239, 68, 68, 0.45)';
  ctx.shadowBlur = 8 / scale;

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = isValid ? 'rgba(249, 115, 22, 0.28)' : 'rgba(239, 68, 68, 0.28)';
  ctx.fill();
  ctx.strokeStyle = isValid ? '#f97316' : '#ef4444';
  ctx.lineWidth = 2 / scale;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + radius * 1.4, y);
  ctx.strokeStyle = isValid ? 'rgba(249, 115, 22, 0.65)' : 'rgba(239, 68, 68, 0.65)';
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  ctx.restore();
}

/**
 * Dünya polyline → trail noktaları (TRAIL_MIN_DIST_M aralıklı örnekleme).
 * Canlı iz odometride aynı mesafede nokta biriktirir; gelecek rota da aynı yoğunlukta
 * görünsün diye — ayrı bir çizgi stili "farklı katman" izlenimi veriyordu.
 */
function samplePolylineTrail(waypoints, minDist = TRAIL_MIN_DIST_M) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) return [];

  const samples = [{ x: waypoints[0].x, y: waypoints[0].y }];
  for (let i = 1; i < waypoints.length; i += 1) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;

    const steps = Math.max(1, Math.round(len / minDist));
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      samples.push({ x: a.x + dx * t, y: a.y + dy * t });
    }
  }
  return samples;
}

/**
 * İz noktalarını dolu daire olarak çizer — geçmiş ve gelecek rotanın ortak tekniği.
 * Tek fark fillStyle (renk); kalınlık/snap/örnekleme paylaşılır ki iki rota görsel dil bir olsun.
 * snap'li worldToDisplayPixel: noktalar engel üzerinde kalmasın diye.
 */
function drawTrailDots(ctx, trail, mapMeta, imageObj, imageData, scale, fillStyle) {
  if (!trail?.length || !mapMeta || !imageObj) return;

  const dotRadius = 1.5 / scale;
  ctx.fillStyle = fillStyle;

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

/** Gelecek rota (yeşil) — aktif görevde kalan hedefler; robot → adımlar. */
function drawUpcomingRoute(ctx, remainingSteps, robotPose, mapMeta, imageObj, imageData, scale) {
  if (!robotPose) return;
  if (!Array.isArray(remainingSteps) || remainingSteps.length === 0) return;

  const waypoints = [
    { x: robotPose.x, y: robotPose.y },
    ...remainingSteps,
  ];
  const trail = samplePolylineTrail(waypoints);
  drawTrailDots(
    ctx,
    trail,
    mapMeta,
    imageObj,
    imageData,
    scale,
    'rgba(6, 168, 155, 0.35)',
  );
}

/** Geçmiş iz (kırmızı) — odometri birikimi; drawUpcomingRoute ile aynı drawTrailDots. */
function drawPositionTrail(ctx, trail, mapMeta, imageObj, imageData, scale) {
  drawTrailDots(
    ctx,
    trail,
    mapMeta,
    imageObj,
    imageData,
    scale,
    'rgba(220, 38, 38, 0.35)',
  );
}

/** Ana harita bileşeni: veri yükleme, odometri dinleme, canvas çizimi ve zoom/pan etkileşimi. */
const MapView = () => {
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
  const { activeTaskRemainingSteps } = useNavigation();

  // Zoom ve pan durumu
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Son tıklanan dünya noktası — sadece bilgi satırı; NavigateToPose / görev başlatmaya bağlanmaz.
  const [lastClickedWorldPos, setLastClickedWorldPos] = useState(null);

  // Canvas boyutu (ResizeObserver ile güncellenir)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // Sol tık sürükleme (pan) — ref ile senkron takip:
  // useState asenkron güncellenir; mouseup anında isPanning hâlâ false görünüp tıklama sanılabilirdi.
  // isPanningRef anlık değeri tutar, pan/tıklama ayrımı doğru çalışır.
  const [isPanning, setIsPanning] = useState(false);
  const isPanningRef = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const panStartPos = useRef({ x: 0, y: 0 });
  const didPanRef = useRef(false);  // sürükleme mi yoksa saf tıklama mı — ref ile senkron
  const layoutRef = useRef(null);
  const viewResetKeyRef = useRef('');

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
        return next.length > TRAIL_MAX ? next.slice(-TRAIL_MAX) : next;  // eski noktaları at
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

    // Kalan görev adımları — kırmızı geçmiş izle aynı nokta tekniği, yeşil
    if (mapMeta && robotPose) {
      drawUpcomingRoute(
        ctx,
        activeTaskRemainingSteps,
        robotPose,
        mapMeta,
        imageObj,
        mapImageDataRef.current,
        totalScale,
      );
    }

    if (robotPose && mapMeta) {
      // Ham worldToPixel: robot fiziksel neredeyse orada görünsün.
      // snapToFreePixel burada kullanılmaz — engel üstündeyken ikon yanlışlıkla serbest alana zıplardı.
      const pixel = worldToPixel(robotPose.x, robotPose.y, mapMeta, imageSize);
      drawRobotArrow(ctx, pixel.x, pixel.y, robotPose.yaw, totalScale);
    }

    ctx.restore();

    ctx.restore();
  }, [
    canvasSize,
    imageObj,
    themedImageObj,
    mapMeta,
    robotPose,
    positionTrail,
    scale,
    offset,
    activeTaskRemainingSteps,
  ]);

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

  // ── 3b. Sol tık basılı tutarak pan (kaydırma) ──
  const finishPointerInteraction = () => {
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

    const handleWindowMouseUp = () => {
      window.removeEventListener('mouseup', handleWindowMouseUp);
      finishPointerInteraction();
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
    // mouseleave ile tetiklenen "mouseup" tıklama sayılmaz
    const wasClick = e.type === 'mouseup' && !didPanRef.current;
    finishPointerInteraction();

    if (!wasClick || !mapMeta || !imageObj) return;

    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout) return;

    const { x: canvasX, y: canvasY } = clientToCanvasPixel(e.clientX, e.clientY, canvas);
    // Snap yok — tıklanan ham dünya koordinatı; navigasyon göndermez, sadece bilgi.
    const world = canvasToWorldPreview(
      canvasX,
      canvasY,
      imageObj,
      mapMeta,
      mapImageDataRef.current,
      layout.fitScale,
      layout.centerX,
      layout.centerY,
      scaleRef.current,
      offsetRef.current,
    );
    // Harita dışına tıklanınca önceki değeri koru (temizleme)
    if (world) {
      setLastClickedWorldPos({ x: world.x, y: world.y });
    }
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
        {lastClickedWorldPos && (
          <span>
            &nbsp;|&nbsp; Son tıklanan: X {lastClickedWorldPos.x.toFixed(2)} m, Y {lastClickedWorldPos.y.toFixed(2)} m
          </span>
        )}
      </div>

      {loadError && (
        <p className="map-view-error">{loadError}</p>
      )}

      <div
        ref={containerRef}
        className={`map-view-canvas-wrap${isPanning ? ' is-panning' : ''}`}
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

      {/* Dashboard'da .map-view-meta gizli; çerçeve altında görünür kopya (overflow kırpmasın diye). */}
      {lastClickedWorldPos && (
        <p className="autonomous-panel__meta map-click-coord">
          Son tıklanan: X {lastClickedWorldPos.x.toFixed(2)} m, Y {lastClickedWorldPos.y.toFixed(2)} m
        </p>
      )}

      <p className="map-view-footer">
        Fare tekerleği: yakınlaştır/uzaklaştır &nbsp;|&nbsp; Sol tık + sürükle: haritayı kaydır
      </p>
    </div>
  );
};

export default MapView;
