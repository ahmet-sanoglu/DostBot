// Mühendis paneli — konum ekleme/düzenleme modal formu.
// Kaydedilince backend otomatik tek adımlı görev de oluşturur/günceller; yaw derece → radyan dönüşümü yapılır.

import React, { useEffect, useState } from 'react';
import { degreesToRadians } from '../../utils/rosNavigation';
import EngineerModal from './EngineerModal';

/** Radyan yaw'ı formda gösterilecek derece string'ine çevirir. */
function radiansToDegreesString(yaw) {
  if (typeof yaw !== 'number' || Number.isNaN(yaw)) {
    return '0';
  }
  return ((yaw * 180) / Math.PI).toFixed(1);
}

/** Konum nesnesinden form state'ini üretir (edit modunda modal açılınca doldurulur). */
function locationToFormState(location) {
  if (!location) {
    return { name: '', x: '', y: '', yaw: '0' };
  }

  return {
    name: location.name || '',
    x: typeof location.x === 'number' ? String(location.x) : '',
    y: typeof location.y === 'number' ? String(location.y) : '',
    yaw: radiansToDegreesString(location.yaw),
  };
}

/**
 * mode + initialLocation: aynı modal hem ekleme hem düzenleme için — EngineerPage hangi API'yi
 * çağıracağını mode'a bakarak seçer (POST vs PUT).
 */
export default function AddLocationModal({
  open,
  onClose,
  onSave,
  saving,
  error,
  mode = 'create',
  initialLocation = null,
}) {
  const isEditMode = mode === 'edit';
  const modalTitle = isEditMode ? 'Konumu Düzenle' : 'Konum Ekle';
  const modalTitleId = isEditMode ? 'edit-location-title' : 'add-location-title';

  const [name, setName] = useState('');
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [yaw, setYaw] = useState('0');

  // Modal her açıldığında formu sıfırla veya initialLocation'dan doldur (edit modu)
  useEffect(() => {
    if (!open) return;

    const formState = isEditMode
      ? locationToFormState(initialLocation)
      : locationToFormState(null);

    setName(formState.name);
    setX(formState.x);
    setY(formState.y);
    setYaw(formState.yaw);
  }, [open, isEditMode, initialLocation]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const parsedX = parseFloat(x);
    const parsedY = parseFloat(y);
    const parsedYaw = parseFloat(yaw);
    if (!name.trim() || Number.isNaN(parsedX) || Number.isNaN(parsedY) || Number.isNaN(parsedYaw)) {
      return;
    }

    const saved = await onSave({
      name: name.trim(),
      x: parsedX,
      y: parsedY,
      yaw: degreesToRadians(parsedYaw),  // ROS radyan bekler
    }, mode);

    if (saved && !isEditMode) {
      setName('');
      setX('');
      setY('');
      setYaw('0');
    }
  };

  return (
    <EngineerModal open={open} onClose={onClose} ariaLabelledBy={modalTitleId}>
      <h3 id={modalTitleId}>{modalTitle}</h3>
      <form className="engineer-form" onSubmit={handleSubmit}>
        <label className="engineer-form__field">
          <span>İsim</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn. Sera Girişi"
            required
          />
        </label>
        <label className="engineer-form__field">
          <span>X (m)</span>
          <input
            type="number"
            step="0.01"
            value={x}
            onChange={(e) => setX(e.target.value)}
            required
          />
        </label>
        <label className="engineer-form__field">
          <span>Y (m)</span>
          <input
            type="number"
            step="0.01"
            value={y}
            onChange={(e) => setY(e.target.value)}
            required
          />
        </label>
        <label className="engineer-form__field">
          <span>Yaw (°)</span>
          <input
            type="number"
            step="0.1"
            value={yaw}
            onChange={(e) => setYaw(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="engineer-form__error">{error}</p>
        )}
        <div className="engineer-form__actions">
          <button type="button" className="autonomous-btn autonomous-btn--ghost" onClick={onClose}>
            İptal
          </button>
          <button type="submit" className="autonomous-btn" disabled={saving}>
            {saving ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
        </div>
      </form>
    </EngineerModal>
  );
}
