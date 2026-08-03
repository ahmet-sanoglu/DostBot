// Mühendis panelindeki küçük canlı harita — robot, geofence ve yasak dikdörtgen çizimi.
// Geofence (drawMode): çoklu köşe poligon; yasak bölge (forbiddenDrawMode): tam 2 tık = 1 dikdörtgen.
// İki mod ayrı state — aynı tıklama dinleyicisinde karışmasın, biri açılınca diğeri kapansın diye.
// Genişlik: sabit 340px değil — ResizeObserver ile kart clientWidth; kamera yanına eklenince
// kart genişleyince canvas sağda boşluk bırakmasın (MapView gibi container'a uysun).

import React, { useEffect, useRef, useState } from 'react';
import { Topic } from 'roslib';
import { useRos } from '../../context/RosContext';
import { useTelemetry } from '../../context/TelemetryContext';
import {
  MAP_ROTATION,
  getImageSize,
  getMapFitTransform,
  worldToPixel,
  imagePixelToWorld,
  displayLocalToImagePixel,
  quaternionToYaw,
  smoothPose,
  computeRotatedCanvasHeight,
} from '../../utils/mapCoordinates';

const MAP_METADATA_URL = 'http://localhost:5000/api/map/metadata';
const MAP_IMAGE_URL = 'http://localhost:5000/api/map/image';
const ODOMETRY_TOPIC = '/odometry/filtered_uwb';

/** Canvas tıklamasını dünya koordinatına çevirir (geofence / yasak bölge köşe için). */
function canvasToWorld(canvasX, canvasY, mapMeta, imageObj, canvasWidth, canvasHeight) {
  const imageSize = getImageSize(imageObj);
  const { fitScale, centerX, centerY, displayW, displayH } = getMapFitTransform(
    imageSize,
    canvasWidth,
    canvasHeight,
  );
  const localX = (canvasX - centerX) / fitScale;
  const localY = (canvasY - centerY) / fitScale;

  if (localX < 0 || localY < 0 || localX >= displayW || localY >= displayH) {
    return null;
  }

  const imgPixel = displayLocalToImagePixel(localX, localY, imageSize);
  return imagePixelToWorld(imgPixel.x, imgPixel.y, mapMeta, imageSize);
}

function drawRobotMarker(ctx, x, y, yaw, scale) {
  const size = 10 / scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-yaw);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.65, size * 0.55);
  ctx.lineTo(-size * 0.65, -size * 0.55);
  ctx.closePath();
  ctx.fillStyle = '#06A89B';
  ctx.fill();
  ctx.strokeStyle = '#025539';
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();
  ctx.restore();
}

/** Kayıtlı veya taslak geofence poligonunu harita üzerinde çizer. */
function drawBoundaryPolygon(ctx, vertices, mapMeta, imageSize, scale, { closed = false } = {}) {
  if (!vertices?.length) return;

  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = '#06A89B';
  ctx.fillStyle = 'rgba(6, 168, 155, 0.18)';
  ctx.lineWidth = 2 / scale;
  ctx.lineJoin = 'round';

  ctx.beginPath();
  vertices.forEach((vertex, index) => {
    const pixel = worldToPixel(vertex.x, vertex.y, mapMeta, imageSize);
    if (index === 0) {
      ctx.moveTo(pixel.x, pixel.y);
    } else {
      ctx.lineTo(pixel.x, pixel.y);
    }
  });

  if (closed && vertices.length >= 3) {
    ctx.closePath();
    ctx.fill();
  }
  ctx.stroke();

  const dotRadius = 4 / scale;
  ctx.fillStyle = '#025539';
  vertices.forEach((vertex) => {
    const pixel = worldToPixel(vertex.x, vertex.y, mapMeta, imageSize);
    ctx.beginPath();
    ctx.arc(pixel.x, pixel.y, dotRadius, 0, 2 * Math.PI);
    ctx.fill();
  });

  ctx.restore();
}

/** Yasak dikdörtgen — kırmızı; geofence yeşilinden ayırt edilsin diye. */
function drawForbiddenRect(ctx, rect, mapMeta, imageSize, scale, { dashed = false } = {}) {
  if (!rect) return;
  const { xMin, xMax, yMin, yMax } = rect;
  if (
    typeof xMin !== 'number' || typeof xMax !== 'number'
    || typeof yMin !== 'number' || typeof yMax !== 'number'
  ) {
    return;
  }

  const corners = [
    worldToPixel(xMin, yMin, mapMeta, imageSize),
    worldToPixel(xMax, yMin, mapMeta, imageSize),
    worldToPixel(xMax, yMax, mapMeta, imageSize),
    worldToPixel(xMin, yMax, mapMeta, imageSize),
  ];

  ctx.save();
  ctx.setLineDash(dashed ? [6 / scale, 4 / scale] : []);
  ctx.strokeStyle = '#dc2626';
  ctx.fillStyle = 'rgba(220, 38, 38, 0.22)';
  ctx.lineWidth = 2 / scale;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  corners.forEach((corner, index) => {
    if (index === 0) ctx.moveTo(corner.x, corner.y);
    else ctx.lineTo(corner.x, corner.y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** İki dünya köşesinden axis-aligned dikdörtgen — poligon vertex listesi gerekmez. */
function rectFromCorners(a, b) {
  return {
    xMin: Math.min(a.x, b.x),
    xMax: Math.max(a.x, b.x),
    yMin: Math.min(a.y, b.y),
    yMax: Math.max(a.y, b.y),
  };
}

function getCanvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

/** Mühendis paneli mini harita — canlı robot, sınır ve yasak bölge çizimi. */
export default function EngineerMiniMap({
  boundaryPolygon = null,
  draftVertices = [],
  draftClosed = false,
  drawMode = false,
  onVertexAdd,
  onDrawFinish,
  forbiddenZones = [],
  forbiddenDrawMode = false,
  forbiddenCorner = null,
  forbiddenDraftRect = null,
  onForbiddenCornerClick,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const layoutRef = useRef(null);
  const smoothedPoseRef = useRef(null);
  const { ros } = useRos();
  const { setPose: setTelemetryPose } = useTelemetry();
  const [mapMeta, setMapMeta] = useState(null);
  const [imageObj, setImageObj] = useState(null);
  const [robotPose, setRobotPose] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // Kart iç genişliği (ResizeObserver); sabit 340px karttan küçük kalıp sağda boşluk bırakıyordu
  const [mapWidth, setMapWidth] = useState(0);
  const [mapHeight, setMapHeight] = useState(0);
  const [previewCorner, setPreviewCorner] = useState(null);
  // Son tıklanan — bilgi satırı; drawMode/forbiddenDrawMode köşe eklemeyi değiştirmez, üzerine eklenir.
  const [lastClickedWorldPos, setLastClickedWorldPos] = useState(null);

  const anyDrawMode = drawMode || forbiddenDrawMode;

  useEffect(() => {
    fetch(MAP_METADATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error('metadata');
        return res.json();
      })
      .then(setMapMeta)
      .catch(() => setLoadError('Harita metadata yüklenemedi.'));

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      setImageObj(img);
    };
    img.onerror = () => setLoadError('Harita görüntüsü yüklenemedi.');
    img.src = MAP_IMAGE_URL;
  }, []);

  // Kart (wrap) clientWidth → canvas; çizim modunda kart genişleyince yeniden ölçülür
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const syncWidth = () => {
      const width = Math.floor(el.clientWidth);
      if (width <= 0) return;
      setMapWidth((prev) => (prev === width ? prev : width));
    };

    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, [anyDrawMode]);

  useEffect(() => {
    if (!imageObj || mapWidth <= 0) return;
    setMapHeight(computeRotatedCanvasHeight(imageObj, mapWidth));
  }, [imageObj, mapWidth]);

  useEffect(() => {
    if (!ros) return undefined;

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
      setTelemetryPose(smoothed);
    });

    return () => odomTopic.unsubscribe();
  }, [ros, setTelemetryPose]);

  // Çizim bitince önizleme kalmasın
  useEffect(() => {
    if (!forbiddenDrawMode || !forbiddenCorner) {
      setPreviewCorner(null);
    }
  }, [forbiddenDrawMode, forbiddenCorner]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageObj || !mapMeta || mapWidth <= 0 || mapHeight <= 0) return;

    canvas.width = mapWidth;
    canvas.height = mapHeight;

    const ctx = canvas.getContext('2d');
    const imageSize = getImageSize(imageObj);
    const layout = getMapFitTransform(imageSize, canvas.width, canvas.height);
    const { fitScale, centerX, centerY } = layout;
    layoutRef.current = layout; // şimdilik saklanır; tıklama dönüşümü canvasToWorld ile yeniden hesaplar

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f0fdf4';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.scale(fitScale, fitScale);
    ctx.save();
    ctx.translate(0, imageSize.width - 1);
    ctx.rotate(-MAP_ROTATION);
    ctx.drawImage(imageObj, 0, 0);

    if (boundaryPolygon?.length >= 3) {
      drawBoundaryPolygon(ctx, boundaryPolygon, mapMeta, imageSize, fitScale, { closed: true });
    }

    if (draftVertices.length > 0) {
      drawBoundaryPolygon(
        ctx,
        draftVertices,
        mapMeta,
        imageSize,
        fitScale,
        { closed: draftClosed && draftVertices.length >= 3 },
      );
    }

    (Array.isArray(forbiddenZones) ? forbiddenZones : []).forEach((zone) => {
      drawForbiddenRect(ctx, zone, mapMeta, imageSize, fitScale);
    });

    if (forbiddenDraftRect) {
      drawForbiddenRect(ctx, forbiddenDraftRect, mapMeta, imageSize, fitScale);
    }

    // İlk köşe + fare: önizleme dikdörtgeni (ikinci tıklama öncesi)
    if (forbiddenCorner && previewCorner) {
      drawForbiddenRect(
        ctx,
        rectFromCorners(forbiddenCorner, previewCorner),
        mapMeta,
        imageSize,
        fitScale,
        { dashed: true },
      );
    } else if (forbiddenCorner) {
      const pixel = worldToPixel(forbiddenCorner.x, forbiddenCorner.y, mapMeta, imageSize);
      ctx.beginPath();
      ctx.fillStyle = '#dc2626';
      ctx.arc(pixel.x, pixel.y, 4 / fitScale, 0, 2 * Math.PI);
      ctx.fill();
    }

    if (robotPose) {
      const pixel = worldToPixel(robotPose.x, robotPose.y, mapMeta, imageSize);
      drawRobotMarker(ctx, pixel.x, pixel.y, robotPose.yaw, fitScale);
    }

    ctx.restore();
    ctx.restore();
  }, [
    imageObj,
    mapMeta,
    mapWidth,
    mapHeight,
    robotPose,
    boundaryPolygon,
    draftVertices,
    draftClosed,
    forbiddenZones,
    forbiddenCorner,
    forbiddenDraftRect,
    previewCorner,
  ]);

  const handleCanvasClick = (event) => {
    if (!mapMeta || !imageObj) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const point = getCanvasPoint(event, canvas);
    const world = canvasToWorld(point.x, point.y, mapMeta, imageObj, canvas.width, canvas.height);
    // Bilgi satırı: çizim modundan bağımsız; harita dışı tıklamada önceki değeri koru
    if (world) {
      setLastClickedWorldPos({ x: world.x, y: world.y });
    }
    if (!world) return;

    // Poligon: her tık +vertex; dikdörtgen: parent 1. köşe / 2. köşe ile bitirir (çoklu köşe yok)
    if (forbiddenDrawMode && onForbiddenCornerClick) {
      onForbiddenCornerClick(world);
      return;
    }

    if (drawMode && onVertexAdd) {
      onVertexAdd(world);
    }
  };

  const handleDoubleClick = (event) => {
    if (!drawMode || !onDrawFinish) return;
    event.preventDefault();
    onDrawFinish();
  };

  const handleMouseMove = (event) => {
    const canvas = canvasRef.current;
    if (!canvas || !mapMeta || !imageObj) return;

    // 1. köşe seçiliyken fareyle karşı köşe önizlemesi (2. tık kesinleştirir)
    if (forbiddenDrawMode && forbiddenCorner) {
      const point = getCanvasPoint(event, canvas);
      const world = canvasToWorld(point.x, point.y, mapMeta, imageObj, canvas.width, canvas.height);
      setPreviewCorner(world);
    }
  };

  const handleMouseLeave = () => {
    setPreviewCorner(null);
  };

  let hintText = null;
  if (drawMode) {
    hintText = 'Haritaya tıklayarak köşe ekleyin';
  } else if (forbiddenDrawMode) {
    hintText = forbiddenCorner
      ? 'Karşı köşeyi seçin'
      : 'Dikdörtgenin ilk köşesine tıklayın';
  }

  return (
    <div className="engineer-mini-map-wrap" ref={containerRef}>
      <div
        className={`engineer-mini-map${anyDrawMode ? ' engineer-mini-map--draw' : ''}`}
        style={mapWidth > 0 && mapHeight > 0 ? { width: mapWidth, height: mapHeight } : undefined}
      >
        {loadError && (
          <p className="engineer-mini-map__error">{loadError}</p>
        )}
        {hintText && (
          <p className="engineer-mini-map__hint">{hintText}</p>
        )}
        {mapWidth > 0 && mapHeight > 0 && (
          <canvas
            ref={canvasRef}
            className="engineer-mini-map__canvas"
            width={mapWidth}
            height={mapHeight}
            onClick={handleCanvasClick}
            onDoubleClick={handleDoubleClick}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          />
        )}
      </div>
      {lastClickedWorldPos && (
        <p className="autonomous-panel__meta map-click-coord">
          Son tıklanan: X {lastClickedWorldPos.x.toFixed(2)} m, Y {lastClickedWorldPos.y.toFixed(2)} m
        </p>
      )}
    </div>
  );
}
