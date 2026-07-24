// Geofence (geçilebilir alan sınırı) çizim ve kaydetme kontrolleri.
// EngineerMiniMap ile birlikte çalışır; operatör hedefleri bu poligon içinde olmalıdır.

import React, { useState } from 'react';
import ConfirmDialog from './ConfirmDialog';

/** Sınır çizme modu, kaydetme ve silme butonlarını yönetir. */
export default function BoundarySettings({
  boundaryPolygon,
  drawMode,
  draftVertices,
  draftClosed,
  saving,
  error,
  onStartDraw,
  onFinishDraw,
  onCancelDraw,
  onSave,
  onDelete,
}) {
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const hasSavedBoundary = Boolean(boundaryPolygon?.length >= 3);
  const hasDraftToSave = !drawMode && draftClosed && draftVertices.length >= 3;

  const handleConfirmDelete = () => {
    setConfirmDeleteOpen(false);
    onDelete();
  };

  return (
    <div className="boundary-settings">
      <p className="autonomous-panel__meta">
        Geçilebilir alan sınırı (poligon). Operatör panelinde hedefler bu alanın içinde olmalıdır.
      </p>

      {hasSavedBoundary && !drawMode && (
        <p className="autonomous-panel__meta">
          Kayıtlı sınır: {boundaryPolygon.length} köşe
        </p>
      )}

      {error && (
        <p className="engineer-form__error">{error}</p>
      )}

      {drawMode ? (
        <>
          <p className="autonomous-panel__meta">
            Çizim modu ({draftVertices.length} köşe). Bitir veya çift tıkla ile kapatın.
          </p>
          <div className="boundary-settings__actions">
            <button
              type="button"
              className="autonomous-btn autonomous-btn--small"
              onClick={onFinishDraw}
              disabled={draftVertices.length < 3}
            >
              Bitir
            </button>
            <button
              type="button"
              className="autonomous-btn autonomous-btn--ghost autonomous-btn--small"
              onClick={onCancelDraw}
            >
              İptal
            </button>
          </div>
        </>
      ) : (
        <div className="boundary-settings__actions">
          <button
            type="button"
            className="autonomous-btn autonomous-btn--small"
            onClick={onStartDraw}
            disabled={saving}
          >
            Alan Sınırı Çiz
          </button>

          {hasDraftToSave && (
            <button
              type="button"
              className="autonomous-btn autonomous-btn--small"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          )}

          {hasSavedBoundary && (
            <button
              type="button"
              className="autonomous-btn autonomous-btn--ghost autonomous-btn--small"
              onClick={() => setConfirmDeleteOpen(true)}
              disabled={saving}
            >
              Sınırı Sil
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Sınırı Sil"
        message="Geçilebilir alan sınırını silmek istediğinize emin misiniz? Bu, operatör panelindeki hedef kısıtlamasını kaldırır."
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
