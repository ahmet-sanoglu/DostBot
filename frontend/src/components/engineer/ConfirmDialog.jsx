// Yeniden kullanılabilir onay penceresi — mühendis panelinde yıkıcı eylemlerden önce sorar.
// Senaryolar: Görev Sil, Alan Sınırını Sil, Harita Sil (ConfirmDialog / BoundarySettings / MapSelector).
// EngineerModal (createPortal) üzerine kurulur; aynı z-index/backdrop çözümünü paylaşır
// (sayfa içinde render edilince butonlar overlay üstünde kalıyordu).

import React, { useId } from 'react';
import EngineerModal from './EngineerModal';

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {string} props.title
 * @param {string} props.message
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onCancel
 */
export default function ConfirmDialog({ open, title, message, onConfirm, onCancel }) {
  const titleId = useId();

  return (
    <EngineerModal open={open} onClose={onCancel} ariaLabelledBy={titleId}>
      <h3 id={titleId}>{title}</h3>
      <p className="engineer-confirm__message">{message}</p>
      <div className="engineer-form__actions">
        <button
          type="button"
          className="autonomous-btn autonomous-btn--ghost"
          onClick={onCancel}
        >
          İptal
        </button>
        <button
          type="button"
          className="autonomous-btn autonomous-btn--danger"
          onClick={onConfirm}
        >
          Sil
        </button>
      </div>
    </EngineerModal>
  );
}
