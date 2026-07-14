import React, { useState } from 'react';
import { degreesToRadians } from '../../utils/rosNavigation';

export default function AddLocationModal({ open, onClose, onSave, saving, error }) {
  const [name, setName] = useState('');
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [yaw, setYaw] = useState('0');

  if (!open) return null;

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
      yaw: degreesToRadians(parsedYaw),
    });

    if (saved) {
      setName('');
      setX('');
      setY('');
      setYaw('0');
    }
  };

  return (
    <div className="engineer-modal-backdrop" role="presentation">
      <div className="engineer-modal" role="dialog" aria-labelledby="add-location-title">
        <h3 id="add-location-title">Konum Ekle</h3>
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
      </div>
    </div>
  );
}
