import React, { useEffect, useRef, useState } from 'react';
import { Topic } from 'roslib';
import { useRos } from '../../context/RosContext';
import { useTelemetry } from '../../context/TelemetryContext';
import { normalizeAngle } from '../../utils/rosNavigation';

const MAP_METADATA_URL = 'http://localhost:5000/api/map/metadata';
const MAP_IMAGE_URL = 'http://localhost:5000/api/map/image';
const ODOMETRY_TOPIC = '/odometry/filtered_uwb';
const MAP_ROTATION = Math.PI / 2;
const MINI_MAP_WIDTH = 340;
const DRAW_MAP_WIDTH = 480;
const POS_SMOOTH_ALPHA = 0.35;
const YAW_SMOOTH_ALPHA = 0.25;

function getImageSize(imageObj) {
  return { width: imageObj.width, height: imageObj.height };
}

function getMapFitTransform(imageSize, canvasWidth, canvasHeight) {
  const displayW = imageSize.height;
  const displayH = imageSize.width;

  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return { fitScale: 1, centerX: 0, centerY: 0 };
  }

  const fitScale = Math.min(canvasWidth / displayW, canvasHeight / displayH);
  const centerX = (canvasWidth - displayW * fitScale) / 2;
  const centerY = (canvasHeight - displayH * fitScale) / 2;

  return { fitScale, centerX, centerY, displayW, displayH };
}

function worldToPixel(worldX, worldY, metadata, imageSize) {
  const pixelX = (worldX - metadata.origin[0]) / metadata.resolution;
  const pixelY = imageSize.height - (worldY - metadata.origin[1]) / metadata.resolution;
  return { x: pixelX, y: pixelY };
}

function displayLocalToImagePixel(localX, localY, imageSize) {
  return {
    x: imageSize.width - 1 - localY,
    y: localX,
  };
}

function imagePixelToWorld(pixelX, pixelY, metadata, imageSize) {
  const worldX = pixelX * metadata.resolution + metadata.origin[0];
  const worldY = (imageSize.height - pixelY) * metadata.resolution + metadata.origin[1];
  return { x: worldX, y: worldY };
}

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

function quaternionToYaw(x, y, z, w) {
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

function angleDifference(a, b) {
  let diff = a - b;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
}

function smoothPose(raw, prev) {
  if (!prev) {
    return { x: raw.x, y: raw.y, yaw: normalizeAngle(raw.yaw) };
  }

  let smoothedYaw = normalizeAngle(prev.yaw)
    + angleDifference(raw.yaw, prev.yaw) * YAW_SMOOTH_ALPHA;

  return {
    x: prev.x + POS_SMOOTH_ALPHA * (raw.x - prev.x),
    y: prev.y + POS_SMOOTH_ALPHA * (raw.y - prev.y),
    yaw: normalizeAngle(smoothedYaw),
  };
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

export default function EngineerMiniMap({
  locations = [],
  boundaryPolygon = null,
  draftVertices = [],
  draftClosed = false,
  drawMode = false,
  onVertexAdd,
  onDrawFinish,
}) {
  const canvasRef = useRef(null);
  const layoutRef = useRef(null);
  const smoothedPoseRef = useRef(null);
  const { ros } = useRos();
  const { setPose: setTelemetryPose } = useTelemetry();
  const [mapMeta, setMapMeta] = useState(null);
  const [imageObj, setImageObj] = useState(null);
  const [robotPose, setRobotPose] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [mapHeight, setMapHeight] = useState(Math.round(MINI_MAP_WIDTH * 0.75));

  const mapWidth = drawMode ? DRAW_MAP_WIDTH : MINI_MAP_WIDTH;

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

  useEffect(() => {
    if (!imageObj) return;
    const aspect = imageObj.width / imageObj.height;
    setMapHeight(Math.round(mapWidth * aspect));
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageObj || !mapMeta) return;

    canvas.width = mapWidth;
    canvas.height = mapHeight;

    const ctx = canvas.getContext('2d');
    const imageSize = getImageSize(imageObj);
    const layout = getMapFitTransform(imageSize, canvas.width, canvas.height);
    const { fitScale, centerX, centerY } = layout;
    layoutRef.current = layout;

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

    locations.forEach((location) => {
      if (typeof location.x !== 'number' || typeof location.y !== 'number') return;
      const pixel = worldToPixel(location.x, location.y, mapMeta, imageSize);
      const markerRadius = Math.max(3, 5 / fitScale);

      ctx.beginPath();
      ctx.fillStyle = '#025539';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 / fitScale;
      ctx.arc(pixel.x, pixel.y, markerRadius, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    });

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
    locations,
    robotPose,
    boundaryPolygon,
    draftVertices,
    draftClosed,
  ]);

  const handleCanvasClick = (event) => {
    if (!drawMode || !onVertexAdd || !mapMeta || !imageObj) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const canvasX = (event.clientX - rect.left) * scaleX;
    const canvasY = (event.clientY - rect.top) * scaleY;

    const world = canvasToWorld(canvasX, canvasY, mapMeta, imageObj, canvas.width, canvas.height);
    if (world) {
      onVertexAdd(world);
    }
  };

  const handleDoubleClick = (event) => {
    if (!drawMode || !onDrawFinish) return;
    event.preventDefault();
    onDrawFinish();
  };

  return (
    <div
      className={`engineer-mini-map${drawMode ? ' engineer-mini-map--draw' : ''}`}
      style={{ width: mapWidth, height: mapHeight }}
    >
      {loadError && (
        <p className="engineer-mini-map__error">{loadError}</p>
      )}
      {drawMode && (
        <p className="engineer-mini-map__hint">Haritaya tıklayarak köşe ekleyin</p>
      )}
      <canvas
        ref={canvasRef}
        className="engineer-mini-map__canvas"
        width={mapWidth}
        height={mapHeight}
        onClick={handleCanvasClick}
        onDoubleClick={handleDoubleClick}
      />
    </div>
  );
}
