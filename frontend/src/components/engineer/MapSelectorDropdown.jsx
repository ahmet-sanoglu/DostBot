import React, { useEffect, useRef, useState } from 'react';

export default function MapSelectorDropdown({ activeMap }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const handleClickOutside = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div className="engineer-map-selector" ref={rootRef}>
      <button
        type="button"
        className="engineer-map-selector__trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span>{activeMap?.name || 'Harita yükleniyor…'}</span>
        <span className="engineer-map-selector__caret" aria-hidden="true">⌄</span>
      </button>

      {open && (
        <ul className="engineer-map-selector__menu" role="listbox">
          {activeMap && (
            <li
              className="engineer-map-selector__item engineer-map-selector__item--active"
              role="option"
              aria-selected="true"
            >
              <span className="engineer-map-selector__check" aria-hidden="true">✓</span>
              {activeMap.name}
            </li>
          )}
          <li className="engineer-map-selector__item engineer-map-selector__item--action">
            <button
              type="button"
              className="engineer-map-selector__add"
              disabled
              title="Yakında"
            >
              + Yeni Harita Ekle
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
