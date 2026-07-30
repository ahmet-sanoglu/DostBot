// Görev rotası haritası — AddTaskModal sağ paneli.
// Neden harita: X/Y'yi elle metre girmek hata eğilimli; tıklayınca dünya koordinatı yazılır.
// Sol formla aynı steps state (tek kaynak) — ekstra senkron yok; biri değişince diğeri anında güncellenir.
// Silme: işaretçiye yakın tık/sağ tık — ayrı "Kaldır" aramadan rota düzeltilsin diye.
// Hover cursor: 15px eşikte pointer — yanlışlıkla silinecek noktayı görsel olarak ayırt etmek için.

import React, { useEffect, useRef, useState } from 'react';
import {
  MAP_ROTATION,
  getImageSize,
  getMapFitTransform,
  imagePixelToWorld,
  worldToCanvas,
  canvasToImagePixel,
  clientToCanvasPixel,
  isImagePixelInBounds,
  computeRotatedCanvasHeight,
} from '../../utils/mapCoordinates';

const MAP_METADATA_URL = 'http://localhost:5000/api/map/metadata';
const MAP_IMAGE_URL = 'http://localhost:5000/api/map/image';
const MAP_WIDTH = 420;
/** Canvas piksel eşiği — yanlışlıkla komşu boş alana tıklayınca silinmesin diye. */
const HIT_RADIUS_PX = 15;

/** Form adımından geçerli dünya koordinatı çıkarır; boş/geçersizse null. */
function parseStepWorld(step) {
  const x = typeof step.x === 'number' ? step.x : parseFloat(step.x);
  const y = typeof step.y === 'number' ? step.y : parseFloat(step.y);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return { x, y };
}

/**
 * Canvas tıklamasını dünya koordinatına çevirir.
 * Harita dışı tıklamada null (fit letterbox alanına basılmış olabilir).
 */
function canvasToWorld(canvasX, canvasY, mapMeta, imageObj, layout) {
  const imageSize = getImageSize(imageObj);
  const imgPixel = canvasToImagePixel(
    canvasX,
    canvasY,
    imageSize,
    layout.fitScale,
    layout.centerX,
    layout.centerY,
    1,
    { x: 0, y: 0 },
  );
  if (!isImagePixelInBounds(imgPixel.x, imgPixel.y, imageSize)) {
    return null;
  }
  return imagePixelToWorld(imgPixel.x, imgPixel.y, mapMeta, imageSize);
}

/** Canvas uzayında en yakın işaretçi; eşik dışıysa -1 (boş alan = ekle, yakın = sil). */
function findNearestStepIndex(canvasX, canvasY, steps, mapMeta, imageSize, layout) {
  let bestIndex = -1;
  let bestDist = HIT_RADIUS_PX;

  steps.forEach((step, index) => {
    const world = parseStepWorld(step);
    if (!world) return;
    const screen = worldToCanvas(world.x, world.y, mapMeta, imageSize, layout);
    const dist = Math.hypot(screen.x - canvasX, screen.y - canvasY);
    if (dist <= bestDist) {
      bestDist = dist;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function drawRouteAndMarkers(ctx, steps, mapMeta, imageSize, layout) {
  // Numaralar screen-space'te — döndürülmüş image context'te metin ters okunmasın diye.
  const points = [];
  steps.forEach((step, index) => {
    const world = parseStepWorld(step);
    if (!world) return;
    const screen = worldToCanvas(world.x, world.y, mapMeta, imageSize, layout);
    points.push({ ...screen, index });
  });

  if (points.length >= 2) {
    ctx.save();
    ctx.strokeStyle = 'rgba(6, 168, 155, 0.75)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    points.forEach((point, i) => {
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  points.forEach((point) => {
    const label = String(point.index + 1);
    const radius = 11;

    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = '#06A89B';
    ctx.fill();
    ctx.strokeStyle = '#025539';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, point.x, point.y + 0.5);
    ctx.restore();
  });
}

/**
 * @param {object} props
 * @param {Array<{x: string|number, y: string|number, yaw: string|number, actionType: string}>} props.steps
 * @param {(next: typeof props.steps) => void} props.onStepsChange
 */
export default function TaskRouteMap({ steps, onStepsChange }) {
  const canvasRef = useRef(null);
  const layoutRef = useRef(null);
  const [mapMeta, setMapMeta] = useState(null);
  const [imageObj, setImageObj] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [mapHeight, setMapHeight] = useState(Math.round(MAP_WIDTH * 0.75));
  const [nearMarker, setNearMarker] = useState(false); // hover → pointer; her mousemove setState olmasın diye aşağıda prev===near

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
    img.onload = () => setImageObj(img);
    img.onerror = () => setLoadError('Harita görüntüsü yüklenemedi.');
    img.src = MAP_IMAGE_URL;
  }, []);

  useEffect(() => {
    if (!imageObj) return;
    setMapHeight(computeRotatedCanvasHeight(imageObj, MAP_WIDTH));
  }, [imageObj]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageObj || !mapMeta) return;

    canvas.width = MAP_WIDTH;
    canvas.height = mapHeight;

    const ctx = canvas.getContext('2d');
    const imageSize = getImageSize(imageObj);
    const layout = getMapFitTransform(imageSize, canvas.width, canvas.height);
    layoutRef.current = layout;
    const { fitScale, centerX, centerY } = layout;

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
    // worldToPixel ile rota çizmek yerine screen-space kullanıyoruz —
    // numaralar döndürülmüş context'te ters okunmasın diye.
    ctx.restore();
    ctx.restore();

    drawRouteAndMarkers(ctx, steps, mapMeta, imageSize, layout);
  }, [imageObj, mapMeta, mapHeight, steps]);

  const handlePointer = (event) => {
    event.preventDefault();
    if (!mapMeta || !imageObj || !layoutRef.current) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const point = clientToCanvasPixel(event.clientX, event.clientY, canvas);
    const layout = layoutRef.current;
    const imageSize = getImageSize(imageObj);

    const nearIndex = findNearestStepIndex(
      point.x,
      point.y,
      steps,
      mapMeta,
      imageSize,
      layout,
    );

    if (nearIndex >= 0) {
      // Filtre ile sil — indeksler kayınca form rozeti / harita numarası kendiliğinden hizalanır
      onStepsChange(steps.filter((_, i) => i !== nearIndex));
      return;
    }

    // Sağ tık yalnızca siler; boş yere sağ tık yeni adım eklemez (yanlışlıkla rota uzamasın)
    if (event.button === 2 || event.type === 'contextmenu') {
      return;
    }

    const world = canvasToWorld(point.x, point.y, mapMeta, imageObj, layout);
    if (!world) return;

    const filled = {
      x: world.x.toFixed(2),
      y: world.y.toFixed(2),
      yaw: '0',
      actionType: 'wait',
    };

    // Modal açılışta boş varsayılan satır var — append etmek "2. adım" gibi görünürdü;
    // önce boş x/y satırını doldur, yoksa sona ekle.
    const emptyIndex = steps.findIndex((step) => {
      const xEmpty = step.x === '' || step.x == null;
      const yEmpty = step.y === '' || step.y == null;
      return xEmpty || yEmpty;
    });

    if (emptyIndex >= 0) {
      onStepsChange(steps.map((step, i) => (
        i === emptyIndex
          ? { ...step, x: filled.x, y: filled.y, yaw: step.yaw || filled.yaw }
          : step
      )));
      return;
    }

    onStepsChange([...steps, filled]);
  };

  const handleMouseMove = (event) => {
    if (!mapMeta || !imageObj || !layoutRef.current) {
      setNearMarker(false);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const point = clientToCanvasPixel(event.clientX, event.clientY, canvas);
    const near = findNearestStepIndex(
      point.x,
      point.y,
      steps,
      mapMeta,
      getImageSize(imageObj),
      layoutRef.current,
    ) >= 0;
    setNearMarker((prev) => (prev === near ? prev : near));
  };

  const handleMouseLeave = () => {
    setNearMarker(false);
  };

  return (
    <div className="task-route-map">
      <p className="task-route-map__hint">
        Tıkla: nokta ekle · Noktaya tıkla / sağ tık: sil
      </p>
      <div
        className="task-route-map__frame"
        style={{ width: MAP_WIDTH, height: mapHeight }}
      >
        {loadError && (
          <p className="task-route-map__error">{loadError}</p>
        )}
        <canvas
          ref={canvasRef}
          className="task-route-map__canvas"
          width={MAP_WIDTH}
          height={mapHeight}
          style={{ cursor: nearMarker ? 'pointer' : 'crosshair' }}
          onClick={handlePointer}
          onContextMenu={handlePointer}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      </div>
    </div>
  );
}
