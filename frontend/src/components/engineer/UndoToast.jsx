// Silme sonrası geri alma (undo) bildirimi — yanlış silinen konum/görevi kısa sürede geri getirmek için.
// Akış (EngineerPage): DELETE öncesi snapshot → pendingUndoRef → toast açılır →
//   "Geri Al" → snapshot ile POST (yeni id); 6 sn dolunca veya yeni mühendis işleminde onDismiss → ref temizlenir.
// createPortal ile body'ye basılır; mühendis modal stacking context'inden etkilenmez.

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

/** Geri alma penceresi; süre bitince pendingUndoRef anlamını yitirir (snapshot atılır). */
const UNDO_TOAST_MS = 6000;

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {string} props.message  örn. "Depo silindi"
 * @param {() => void} props.onUndo
 * @param {() => void} props.onDismiss  süre dolunca veya kapanınca — parent pendingUndoRef'i temizler
 */
export default function UndoToast({ open, message, onUndo, onDismiss }) {
  useEffect(() => {
    if (!open) return undefined;

    const timerId = window.setTimeout(() => {
      onDismiss();
    }, UNDO_TOAST_MS);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [open, onDismiss, message]);

  if (!open) return null;

  return createPortal(
    <div className="undo-toast" role="status" aria-live="polite">
      <span className="undo-toast__message">{message}</span>
      <button
        type="button"
        className="undo-toast__undo"
        onClick={onUndo}
      >
        Geri Al
      </button>
    </div>,
    document.body,
  );
}
