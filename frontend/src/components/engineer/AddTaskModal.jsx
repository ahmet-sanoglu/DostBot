import React, { useState } from 'react';

export default function AddTaskModal({
  open,
  locations,
  onClose,
  onSave,
  saving,
  error,
}) {
  const [name, setName] = useState('');
  const [selectedOrder, setSelectedOrder] = useState([]);

  if (!open) return null;

  const toggleLocation = (locationId) => {
    setSelectedOrder((prev) => {
      if (prev.includes(locationId)) {
        return prev.filter((id) => id !== locationId);
      }
      return [...prev, locationId];
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!name.trim() || selectedOrder.length === 0) return;

    const steps = selectedOrder
      .map((id) => locations.find((loc) => loc.id === id))
      .filter(Boolean)
      .map((loc) => ({ x: loc.x, y: loc.y, yaw: loc.yaw }));

    if (steps.length === 0) return;

    const saved = await onSave({
      name: name.trim(),
      steps,
    });

    if (saved) {
      setName('');
      setSelectedOrder([]);
    }
  };

  return (
    <div className="engineer-modal-backdrop" role="presentation">
      <div className="engineer-modal engineer-modal--wide" role="dialog" aria-labelledby="add-task-title">
        <h3 id="add-task-title">Görev Ekle</h3>
        <form className="engineer-form" onSubmit={handleSubmit}>
          <label className="engineer-form__field engineer-form__field--full">
            <span>Görev adı</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Örn. Sera turu"
              required
            />
          </label>

          <div className="engineer-form__field engineer-form__field--full">
            <span>Konumlar (tıklama sırası adım sırasını belirler)</span>
            {locations.length === 0 ? (
              <p className="autonomous-panel__meta">Önce en az bir konum ekleyin.</p>
            ) : (
              <ul className="engineer-location-picker">
                {locations.map((location) => {
                  const orderIndex = selectedOrder.indexOf(location.id);
                  const isSelected = orderIndex >= 0;

                  return (
                    <li key={location.id}>
                      <label className="engineer-location-picker__item">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleLocation(location.id)}
                        />
                        <span className="engineer-location-picker__label">
                          {location.name}
                          {' '}
                          (X {location.x.toFixed(2)}, Y {location.y.toFixed(2)})
                        </span>
                        {isSelected && (
                          <span className="engineer-location-picker__order">
                            Adım {orderIndex + 1}
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {error && (
            <p className="engineer-form__error">{error}</p>
          )}

          <div className="engineer-form__actions">
            <button type="button" className="autonomous-btn autonomous-btn--ghost" onClick={onClose}>
              İptal
            </button>
            <button
              type="submit"
              className="autonomous-btn"
              disabled={saving || selectedOrder.length === 0 || locations.length === 0}
            >
              {saving ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
