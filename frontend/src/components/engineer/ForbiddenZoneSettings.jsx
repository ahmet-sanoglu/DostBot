// Dikdörtgen yasak bölge ekleme/silme — geofence poligonundan farklı: 2 tık = 1 dikdörtgen.
// Manuel X Min/Max Y Min/Max formu kaldırıldı: metre cinsinden dikdörtgeni elle girmek hatalı/zor;
// haritada iki köşe seçmek hem doğru hem geofence çizim ruhuna uyumlu. Formda yalnızca isim kalır.
// Çizim state'i EngineerPage'te (forbiddenDrawMode / pendingRect); bu bileşen UI + ConfirmDialog.

import React, { useState } from 'react';
import ConfirmDialog from './ConfirmDialog';

/**
 * Kayıtlı bölgeler + çizim kontrolleri.
 * drawMode: haritada köşe bekleniyor; pendingRect: dikdörtgen bitti, isim formu açık.
 * Sil ConfirmDialog ile onaylanır.
 */
export default function ForbiddenZoneSettings({
  zones,
  saving,
  error,
  drawMode,
  pendingRect,
  onStartDraw,
  onCancelDraw,
  onSavePending,
  onCancelPending,
  onDelete,
}) {
  const [zoneName, setZoneName] = useState('');
  const [confirmZone, setConfirmZone] = useState(null);

  const zoneList = Array.isArray(zones) ? zones : [];
  // pendingRect varsa isim formu; yoksa drawMode veya "Çiz" butonu — üçü birbirini dışlar
  const showNameForm = Boolean(pendingRect);

  const handleSubmitName = async (event) => {
    event.preventDefault();
    const name = zoneName.trim();
    if (!name || !pendingRect) return;

    const saved = await onSavePending({
      name,
      xMin: pendingRect.xMin,
      xMax: pendingRect.xMax,
      yMin: pendingRect.yMin,
      yMax: pendingRect.yMax,
    });
    if (saved) {
      setZoneName('');
    }
  };

  const handleCancelPending = () => {
    setZoneName('');
    onCancelPending();
  };

  const handleConfirmDelete = () => {
    const zone = confirmZone;
    setConfirmZone(null);
    if (zone?.id) {
      onDelete(zone.id);
    }
  };

  return (
    <div className="forbidden-zone-settings">
      <p className="autonomous-panel__meta">
        Yasaklı dikdörtgen bölgeler. Haritada iki köşe tıklayarak çizin; operatör bu alanlara hedef koyamaz.
      </p>

      {error && (
        <p className="engineer-form__error">{error}</p>
      )}

      {zoneList.length === 0 ? (
        <p className="autonomous-panel__meta">Henüz yasaklı bölge yok.</p>
      ) : (
        <ul className="forbidden-zone-settings__list">
          {zoneList.map((zone) => (
            <li key={zone.id} className="forbidden-zone-settings__item">
              <div>
                <strong>{zone.name || 'Adsız bölge'}</strong>
                <p className="autonomous-panel__meta">
                  X {Number(zone.xMin).toFixed(2)}…{Number(zone.xMax).toFixed(2)} m
                  {' · '}
                  Y {Number(zone.yMin).toFixed(2)}…{Number(zone.yMax).toFixed(2)} m
                </p>
              </div>
              <button
                type="button"
                className="autonomous-btn autonomous-btn--ghost autonomous-btn--small"
                onClick={() => setConfirmZone(zone)}
                disabled={saving || drawMode}
              >
                Sil
              </button>
            </li>
          ))}
        </ul>
      )}

      {showNameForm ? (
        <form className="engineer-form forbidden-zone-settings__form" onSubmit={handleSubmitName}>
          <p className="autonomous-panel__meta engineer-form__field--full">
            X {pendingRect.xMin.toFixed(2)}…{pendingRect.xMax.toFixed(2)} m
            {' · '}
            Y {pendingRect.yMin.toFixed(2)}…{pendingRect.yMax.toFixed(2)} m
          </p>
          <label className="engineer-form__field engineer-form__field--full">
            İsim
            <input
              type="text"
              value={zoneName}
              onChange={(e) => setZoneName(e.target.value)}
              required
              disabled={saving}
              autoFocus
            />
          </label>
          <div className="engineer-form__actions">
            <button
              type="button"
              className="autonomous-btn autonomous-btn--ghost autonomous-btn--small"
              onClick={handleCancelPending}
              disabled={saving}
            >
              İptal
            </button>
            <button
              type="submit"
              className="autonomous-btn autonomous-btn--small"
              disabled={saving}
            >
              {saving ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          </div>
        </form>
      ) : drawMode ? (
        <div className="boundary-settings__actions">
          <p className="autonomous-panel__meta">
            Çizim modu: haritada iki köşe seçin.
          </p>
          <button
            type="button"
            className="autonomous-btn autonomous-btn--ghost autonomous-btn--small"
            onClick={onCancelDraw}
            disabled={saving}
          >
            İptal
          </button>
        </div>
      ) : (
        <div className="boundary-settings__actions">
          <button
            type="button"
            className="autonomous-btn autonomous-btn--small"
            onClick={onStartDraw}
            disabled={saving}
          >
            Yasaklı Bölge Çiz
          </button>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirmZone)}
        title="Yasaklı Bölge Sil"
        message={
          confirmZone
            ? `"${confirmZone.name || 'Adsız bölge'}" adlı yasaklı bölgeyi silmek istediğinize emin misiniz?`
            : ''
        }
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmZone(null)}
      />
    </div>
  );
}
