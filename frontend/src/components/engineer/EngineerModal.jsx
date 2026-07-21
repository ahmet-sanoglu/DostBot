// Mühendis paneli modal kabuğu — Konum Ekle ve Görev Ekle formlarını sarmalar.
// createPortal ile document.body'ye render edilir; sayfa içinde kalınca z-index/backdrop-filter
// sorunları yaşanıyordu (butonlar overlay üstünde görünüyordu) — portal bunu çözer.

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Tam ekran overlay + ortalanmış dialog.
 * createPortal: modal DOM ağacında sayfa kökünün dışına çıkar; stacking context sorunlarını önler.
 */
export default function EngineerModal({
  open,
  onClose,
  wide = false,
  tall = false,
  ariaLabelledBy,
  children,
}) {
  useEffect(() => {
    if (!open) return undefined;

    document.body.classList.add('engineer-modal-open');  // arka plan kaydırmasını kapat

    return () => {
      document.body.classList.remove('engineer-modal-open');
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="engineer-modal-root" role="presentation">
      <div
        className="engineer-modal-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />
      <div className="engineer-modal-layer">
        <div
          className={`engineer-modal${wide ? ' engineer-modal--wide' : ''}${tall ? ' engineer-modal--tall' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ariaLabelledBy}
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
