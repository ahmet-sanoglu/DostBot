// Harita PiP — kamera üzerinde küçük, sürüklenebilir harita.
// Neden PiP? Kontrol Panelinde kamera birincil; harita konum bilgisini kaybetmeden
// köşede kalsın. Üst çubuk = taşıma (bırakınca 4 köşeden birine snap).
// Dört köşe tutamacı = boyutlandırma; her tutamacıda KARŞI köşe sabit kalır
// (pencere ekran dışına kaymasın / alışılmış OS resize davranışı).
// Min/max: çok küçük kullanılamaz, çok büyük kamerayı tamamen örtmesin.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const PIP_DEFAULT_WIDTH = 280;
const PIP_DEFAULT_HEIGHT = 200;
const PIP_MIN_WIDTH = 150;
const PIP_MIN_HEIGHT = 110;
const PIP_MARGIN = 12;

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

// nwse: TL/BR diyagonal; nesw: TR/BL diyagonal — tarayıcı pencere resize imleçleri
const RESIZE_HANDLES = [
  { id: 'top-left', cursor: 'nwse-resize', icon: '↖' },
  { id: 'top-right', cursor: 'nesw-resize', icon: '↗' },
  { id: 'bottom-left', cursor: 'nesw-resize', icon: '↙' },
  { id: 'bottom-right', cursor: 'nwse-resize', icon: '↘' },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Sahne içinde kalacak max PiP boyutu (%50 tavan, sahneyi aşmaz). */
function maxPipSizeForStage(stageW, stageH) {
  if (stageW <= 0 || stageH <= 0) {
    return { width: PIP_DEFAULT_WIDTH, height: PIP_DEFAULT_HEIGHT };
  }
  return {
    width: Math.min(stageW, Math.max(PIP_MIN_WIDTH, Math.floor(stageW * 0.5))),
    height: Math.min(stageH, Math.max(PIP_MIN_HEIGHT, Math.floor(stageH * 0.5))),
  };
}

/** İstenen boyutu sahneye sığdır — varsayılan/reset ile snap tutarlı kalsın. */
function fitPipSizeToStage(width, height, stageW, stageH) {
  const max = maxPipSizeForStage(stageW, stageH);
  return {
    width: clamp(width, Math.min(PIP_MIN_WIDTH, max.width), max.width),
    height: clamp(height, Math.min(PIP_MIN_HEIGHT, max.height), max.height),
  };
}

/** Snap hedefi: serbest konum yok; bırakınca yalnızca bu 4 noktaya oturur.
 * left/top her zaman sahne içinde: 0..stageW-pipW, 0..stageH-pipH (taşma yok).
 */
function positionForCorner(corner, containerWidth, containerHeight, pipW, pipH) {
  const maxLeft = Math.max(0, containerWidth - pipW);
  const maxTop = Math.max(0, containerHeight - pipH);

  let left;
  let top;
  switch (corner) {
    case 'top-left':
      left = PIP_MARGIN;
      top = PIP_MARGIN;
      break;
    case 'top-right':
      left = containerWidth - pipW - PIP_MARGIN;
      top = PIP_MARGIN;
      break;
    case 'bottom-left':
      left = PIP_MARGIN;
      top = containerHeight - pipH - PIP_MARGIN;
      break;
    case 'bottom-right':
    default:
      left = containerWidth - pipW - PIP_MARGIN;
      top = containerHeight - pipH - PIP_MARGIN;
      break;
  }

  // Büyümüş PiP + margin: max(PIP_MARGIN, stage-pip-margin) taşımayı önlemezdi;
  // son adımda mutlaka sahne dikdörtgenine sıkıştır.
  return {
    left: clamp(left, 0, maxLeft),
    top: clamp(top, 0, maxTop),
  };
}

/** Merkeze en yakın köşe — bırakınca "yapışma" hissi. */
function nearestCorner(centerX, centerY, containerWidth, containerHeight, pipW, pipH) {
  let best = 'bottom-right';
  let bestDist = Infinity;

  for (const corner of CORNERS) {
    const pos = positionForCorner(corner, containerWidth, containerHeight, pipW, pipH);
    const cx = pos.left + pipW / 2;
    const cy = pos.top + pipH / 2;
    const dist = (centerX - cx) ** 2 + (centerY - cy) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = corner;
    }
  }

  return best;
}

/**
 * Tutamaca göre w/h + left/top.
 * Neden left/top da değişir? Karşı köşe sabit kalınca büyüyen taraf
 * konumu kaydırır (örn. sol-üst sürüklenince sağ-alt sabit → left/top güncellenir).
 */
function computeResizedBox(handle, start, dx, dy, maxW, maxH, stageW, stageH) {
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  let left = start.left;
  let top = start.top;
  let width = start.width;
  let height = start.height;

  switch (handle) {
    case 'bottom-right': {
      // Sabit: sol-üst (left/top)
      width = clamp(start.width + dx, PIP_MIN_WIDTH, maxW);
      height = clamp(start.height + dy, PIP_MIN_HEIGHT, maxH);
      width = Math.min(width, Math.max(PIP_MIN_WIDTH, stageW - left));
      height = Math.min(height, Math.max(PIP_MIN_HEIGHT, stageH - top));
      break;
    }
    case 'top-left': {
      // Sabit: sağ-alt (right/bottom)
      width = clamp(start.width - dx, PIP_MIN_WIDTH, maxW);
      height = clamp(start.height - dy, PIP_MIN_HEIGHT, maxH);
      left = right - width;
      top = bottom - height;
      if (left < 0) {
        width = Math.min(right, maxW);
        width = Math.max(PIP_MIN_WIDTH, width);
        left = right - width;
      }
      if (top < 0) {
        height = Math.min(bottom, maxH);
        height = Math.max(PIP_MIN_HEIGHT, height);
        top = bottom - height;
      }
      break;
    }
    case 'top-right': {
      // Sabit: sol-alt
      width = clamp(start.width + dx, PIP_MIN_WIDTH, maxW);
      height = clamp(start.height - dy, PIP_MIN_HEIGHT, maxH);
      width = Math.min(width, Math.max(PIP_MIN_WIDTH, stageW - left));
      top = bottom - height;
      if (top < 0) {
        height = Math.min(bottom, maxH);
        height = Math.max(PIP_MIN_HEIGHT, height);
        top = bottom - height;
      }
      break;
    }
    case 'bottom-left': {
      // Sabit: sağ-üst
      width = clamp(start.width - dx, PIP_MIN_WIDTH, maxW);
      height = clamp(start.height + dy, PIP_MIN_HEIGHT, maxH);
      left = right - width;
      height = Math.min(height, Math.max(PIP_MIN_HEIGHT, stageH - top));
      if (left < 0) {
        width = Math.min(right, maxW);
        width = Math.max(PIP_MIN_WIDTH, width);
        left = right - width;
      }
      break;
    }
    default:
      break;
  }

  // Sahne dışına taşmayı son kez kes
  left = clamp(left, 0, Math.max(0, stageW - width));
  top = clamp(top, 0, Math.max(0, stageH - height));

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * @param {object} props
 * @param {React.ReactNode} props.children — genelde MapView
 */
export default function MapPipWindow({ children }) {
  const stageRef = useRef(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const dragPosRef = useRef(null);
  const resizeStartRef = useRef(null);
  const resizePosRef = useRef(null);
  const pipSizeRef = useRef({ width: PIP_DEFAULT_WIDTH, height: PIP_DEFAULT_HEIGHT });

  const [corner, setCorner] = useState('bottom-right');
  const [pipSize, setPipSize] = useState({
    width: PIP_DEFAULT_WIDTH,
    height: PIP_DEFAULT_HEIGHT,
  });
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [dragPos, setDragPos] = useState(null);
  const [resizePos, setResizePos] = useState(null);
  const [, setSizeTick] = useState(0);

  pipSizeRef.current = pipSize;

  const getContainerSize = useCallback(() => {
    const el = stageRef.current;
    if (!el) return { width: 0, height: 0 };
    return { width: el.clientWidth, height: el.clientHeight };
  }, []);

  const getMaxPipSize = useCallback(() => {
    const { width, height } = getContainerSize();
    return maxPipSizeForStage(width, height);
  }, [getContainerSize]);

  // İlk mount + sahne boyutu değişince: varsayılan/reset boyutu sahneye sığdır
  // (PIP_DEFAULT, stage'den büyükse konum clamp yetmez — taşma devam ederdi)
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;

    const syncToStage = () => {
      setSizeTick((n) => n + 1);
      const stageW = el.clientWidth;
      const stageH = el.clientHeight;
      if (stageW <= 0 || stageH <= 0) return;
      setPipSize((prev) => {
        const next = fitPipSizeToStage(prev.width, prev.height, stageW, stageH);
        if (next.width === prev.width && next.height === prev.height) return prev;
        return next;
      });
    };

    syncToStage();
    const observer = new ResizeObserver(syncToStage);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { width: stageW, height: stageH } = getContainerSize();
  // Render anında da boyutu sığdır — ilk paint observer'dan önce taşmasın
  const fittedSize = (stageW > 0 && stageH > 0)
    ? fitPipSizeToStage(pipSize.width, pipSize.height, stageW, stageH)
    : pipSize;
  const snappedPos = stageW > 0 && stageH > 0
    ? positionForCorner(corner, stageW, stageH, fittedSize.width, fittedSize.height)
    : { left: PIP_MARGIN, top: PIP_MARGIN };

  let displayPos = snappedPos;
  if (resizing && resizePos) displayPos = resizePos;
  else if (dragging && dragPos) displayPos = dragPos;

  // Sürükleme/resize anlık konumu da sahne dışında kalmasın
  if (stageW > 0 && stageH > 0) {
    displayPos = {
      left: clamp(displayPos.left, 0, Math.max(0, stageW - fittedSize.width)),
      top: clamp(displayPos.top, 0, Math.max(0, stageH - fittedSize.height)),
    };
  }

  const handleMoveMouseDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const size = getContainerSize();
    const current = positionForCorner(
      corner,
      size.width,
      size.height,
      pipSize.width,
      pipSize.height,
    );

    dragOffsetRef.current = {
      x: event.clientX - rect.left - current.left,
      y: event.clientY - rect.top - current.top,
    };
    dragPosRef.current = current;
    setDragPos(current);
    setDragging(true);
  };

  const handleResizeMouseDown = (handleId) => (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const size = getContainerSize();
    const current = positionForCorner(
      corner,
      size.width,
      size.height,
      pipSize.width,
      pipSize.height,
    );

    const start = {
      handle: handleId,
      x: event.clientX,
      y: event.clientY,
      left: current.left,
      top: current.top,
      width: pipSize.width,
      height: pipSize.height,
    };
    resizeStartRef.current = start;
    resizePosRef.current = { left: current.left, top: current.top };
    setResizePos({ left: current.left, top: current.top });
    setResizing(true);
  };

  // Taşıma — üst çubuk; bırakınca snap (boyutlandırmayla karışmasın diye ayrı effect)
  useEffect(() => {
    if (!dragging) return undefined;

    const onMove = (event) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const size = getContainerSize();
      const { width: pipW, height: pipH } = pipSizeRef.current;
      const maxLeft = Math.max(0, size.width - pipW);
      const maxTop = Math.max(0, size.height - pipH);

      let left = event.clientX - rect.left - dragOffsetRef.current.x;
      let top = event.clientY - rect.top - dragOffsetRef.current.y;
      left = Math.min(maxLeft, Math.max(0, left));
      top = Math.min(maxTop, Math.max(0, top));
      const next = { left, top };
      dragPosRef.current = next;
      setDragPos(next);
    };

    const onUp = () => {
      const pos = dragPosRef.current;
      const size = getContainerSize();
      const { width: pipW, height: pipH } = pipSizeRef.current;
      setDragging(false);
      setDragPos(null);
      dragPosRef.current = null;
      if (!pos || !size.width || !size.height) return;
      setCorner(nearestCorner(
        pos.left + pipW / 2,
        pos.top + pipH / 2,
        size.width,
        size.height,
        pipW,
        pipH,
      ));
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, getContainerSize]);

  // Boyutlandırma — köşe tutamacı; karşı köşe sabit, bırakınca yine snap
  useEffect(() => {
    if (!resizing) return undefined;

    const onMove = (event) => {
      const start = resizeStartRef.current;
      if (!start) return;
      const stage = getContainerSize();
      const max = getMaxPipSize();
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const box = computeResizedBox(
        start.handle,
        start,
        dx,
        dy,
        max.width,
        max.height,
        stage.width,
        stage.height,
      );
      const pos = { left: box.left, top: box.top };
      resizePosRef.current = pos;
      setResizePos(pos);
      setPipSize({ width: box.width, height: box.height });
    };

    const onUp = () => {
      const pos = resizePosRef.current;
      const size = getContainerSize();
      const { width: pipW, height: pipH } = pipSizeRef.current;
      resizeStartRef.current = null;
      resizePosRef.current = null;
      setResizing(false);
      setResizePos(null);
      if (!pos || !size.width || !size.height) return;
      setCorner(nearestCorner(
        pos.left + pipW / 2,
        pos.top + pipH / 2,
        size.width,
        size.height,
        pipW,
        pipH,
      ));
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing, getContainerSize, getMaxPipSize]);

  return (
    <div ref={stageRef} className="map-pip-stage">
      <div
        className={`map-pip${dragging ? ' map-pip--dragging' : ''}${resizing ? ' map-pip--resizing' : ''}`}
        style={{
          width: fittedSize.width,
          height: fittedSize.height,
          left: displayPos.left,
          top: displayPos.top,
        }}
      >
        <div
          className="map-pip__handle"
          onMouseDown={handleMoveMouseDown}
          title="Sürükleyerek köşeye taşı"
        >
          Harita
        </div>
        <div className="map-pip__body">{children}</div>
        {RESIZE_HANDLES.map((handle) => (
          <div
            key={handle.id}
            className={`map-pip__resize map-pip__resize--${handle.id}`}
            style={{ cursor: handle.cursor }}
            onMouseDown={handleResizeMouseDown(handle.id)}
            title="Boyutlandır"
            aria-label={`PiP boyutlandır (${handle.id})`}
          >
            <span className="map-pip__resize-icon" aria-hidden="true">{handle.icon}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
