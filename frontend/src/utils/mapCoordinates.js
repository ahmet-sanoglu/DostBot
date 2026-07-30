// Harita koordinat dönüşümleri — MapView + EngineerMiniMap için tek kaynak.
// Neden ortak: iki dosyada kopyalanan getMapFitTransform/worldToPixel sapınca
// (özellikle küçük/kare haritalarda mini harita aspect oranı) robot ikonu kayıyordu;
// tek doğru matematik = aynı sapmanın tekrarını engeller.
// Occupancy grid 90° saat yönünde döndürülerek landscape gösterilir; tüm dönüşümler buna göre.

/** Harita 90° döndürme sabiti (landscape gösterim). */
export const MAP_ROTATION = Math.PI / 2;

/** Odometri yumuşatma parametreleri. */
export const POS_SMOOTH_ALPHA = 0.35;
export const YAW_SMOOTH_ALPHA = 0.25;

/** Harita görüntüsünün piksel boyutları. */
export function getImageSize(imageObj) {
  return { width: imageObj.width, height: imageObj.height };
}

/**
 * Canvas'a sığdırma ölçeği ve ortalama ofseti (döndürülmüş harita için).
 * Döndürülmüş haritanın ekrandaki görünen boyutu: H × W piksel.
 *
 * Canvas iç transform (kod sırası): translate(0, W−1) → rotate(−π/2)
 * Noktaya uygulama sırası (API): önce rotate, sonra translate
 * → display-local: (iy, W−1−ix), her iki eksen [0, H) × [0, W)
 */
export function getMapFitTransform(imageSize, canvasWidth, canvasHeight) {
  const displayW = imageSize.height;
  const displayH = imageSize.width;

  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return { fitScale: 1, centerX: 0, centerY: 0, displayW, displayH };
  }

  const fitScale = Math.min(canvasWidth / displayW, canvasHeight / displayH);
  const centerX = (canvasWidth - displayW * fitScale) / 2;
  const centerY = (canvasHeight - displayH * fitScale) / 2;

  return { fitScale, centerX, centerY, displayW, displayH };
}

/**
 * ROS dünya koordinatı (metre) → ham occupancy pikseli (döndürme öncesi).
 * Y ekseni: dünya ↑ = piksel ↓ (standart occupancy grid convention).
 */
export function worldToPixel(worldX, worldY, metadata, imageSize) {
  const pixelX = (worldX - metadata.origin[0]) / metadata.resolution;
  const pixelY = imageSize.height - (worldY - metadata.origin[1]) / metadata.resolution;
  return { x: pixelX, y: pixelY };
}

/** Ham piksel → ROS dünya (m); worldToPixel ile terslenebilir. */
export function imagePixelToWorld(pixelX, pixelY, metadata, imageSize) {
  const worldX = pixelX * metadata.resolution + metadata.origin[0];
  const worldY = (imageSize.height - pixelY) * metadata.resolution + metadata.origin[1];
  return { x: worldX, y: worldY };
}

/** Ham piksel → döndürülmüş display-local (iy, W−1−ix). */
export function imagePixelToDisplayLocal(pixelX, pixelY, imageSize) {
  return {
    x: pixelY,
    y: imageSize.width - 1 - pixelX,
  };
}

/** Display-local → ham piksel (imagePixelToDisplayLocal'ın tersi). */
export function displayLocalToImagePixel(localX, localY, imageSize) {
  return {
    x: imageSize.width - 1 - localY,
    y: localX,
  };
}

/** Dünya → canvas ekran pikseli (overlay / çizim için). */
export function worldToCanvas(worldX, worldY, mapMeta, imageSize, layout) {
  const pixel = worldToPixel(worldX, worldY, mapMeta, imageSize);
  const local = imagePixelToDisplayLocal(pixel.x, pixel.y, imageSize);
  return {
    x: layout.centerX + local.x * layout.fitScale,
    y: layout.centerY + local.y * layout.fitScale,
  };
}

/** ROS orientation quaternion'ından düzlemdeki yaw açısını (radyan) çıkarır. */
export function quaternionToYaw(x, y, z, w) {
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

/**
 * Açıyı [-π, +π] aralığına sarar.
 * Bu yapılmazsa yaw birikerek binlerce dereceye çıkar ve ok yanlış yöne bakar.
 */
export function normalizeAngle(angle) {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * İki açı arasındaki en kısa farkı döner (±π içinde).
 * Doğrudan çıkarma yapılırsa 359° ile 1° arasında 358° fark sanılır; yumuşatma bozulur.
 */
export function angleDifference(a, b) {
  let diff = a - b;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
}

/** Odometri gürültüsünü azaltmak için üstel yumuşatma; yaw için normalizeAngle + angleDifference şart. */
export function smoothPose(raw, prev) {
  if (!prev) {
    return { x: raw.x, y: raw.y, yaw: normalizeAngle(raw.yaw) };
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

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Adım: ham occupancy pikselini harita sınırları içinde tutar (taşmayı önler). */
export function clampImagePixel(pixelX, pixelY, imageSize) {
  const maxX = Math.max(0, imageSize.width - 1);
  const maxY = Math.max(0, imageSize.height - 1);
  return {
    x: clamp(pixelX, 0, maxX),
    y: clamp(pixelY, 0, maxY),
  };
}

/** Piksel koordinatının görüntü sınırları içinde olup olmadığını kontrol eder. */
export function isImagePixelInBounds(pixelX, pixelY, imageSize, epsilon = 1e-4) {
  return (
    pixelX >= -epsilon
    && pixelX < imageSize.width - epsilon
    && pixelY >= -epsilon
    && pixelY < imageSize.height - epsilon
  );
}

/**
 * Ham piksel → canvas piksel (zoom/pan/fitScale zinciri).
 * Sıra: display-local → fitScale ile ölçekle → kullanıcı offset/scale uygula.
 */
export function imagePixelToCanvas(
  pixelX, pixelY, imageSize, fitScale, centerX, centerY, userScale, offset,
) {
  const { x: localX, y: localY } = imagePixelToDisplayLocal(pixelX, pixelY, imageSize);
  const viewX = centerX + fitScale * localX;
  const viewY = centerY + fitScale * localY;
  return {
    x: offset.x + userScale * viewX,
    y: offset.y + userScale * viewY,
  };
}

/** Canvas piksel → ham piksel (imagePixelToCanvas'ın tersi — tıklama hedefi için). */
export function canvasToImagePixel(
  canvasX, canvasY, imageSize, fitScale, centerX, centerY, userScale, offset,
) {
  const viewX = (canvasX - offset.x) / userScale;
  const viewY = (canvasY - offset.y) / userScale;
  const localX = (viewX - centerX) / fitScale;
  const localY = (viewY - centerY) / fitScale;
  return displayLocalToImagePixel(localX, localY, imageSize);
}

/** Tarayıcı fare koordinatı (clientX/Y) → canvas iç piksel; CSS boyutu ≠ canvas.width ise ölçeklenir. */
export function clientToCanvasPixel(clientX, clientY, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

/** Dünya koordinatını harita sınırları içinde tutar — köşe piksellerine clamp edip geri çevirir. */
export function clampWorldToMapBounds(worldX, worldY, metadata, imageSize) {
  const pixel = worldToPixel(worldX, worldY, metadata, imageSize);
  const clamped = clampImagePixel(pixel.x, pixel.y, imageSize);
  return imagePixelToWorld(clamped.x, clamped.y, metadata, imageSize);
}

/**
 * Döndürülmüş harita için canvas yüksekliği.
 * Neden width/height oranı: 90° sonrası displayW=imageH, displayH=imageW;
 * ters aspect (height/width) küçük haritalarda fitScale/center sapması ve robot kaymasına yol açıyordu.
 */
export function computeRotatedCanvasHeight(imageObj, canvasWidth) {
  const displayAspect = imageObj.width / imageObj.height;
  return Math.round(canvasWidth * displayAspect);
}
