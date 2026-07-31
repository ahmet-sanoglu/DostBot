// Görev geçmişi modalı — tam sayfa route yerine popup (Sidebar'dan açılır).
// Neden modal? Operatör paneli bağlamından çıkmadan geçmişe bakılsın;
// EngineerModal createPortal: stacking/backdrop-filter sorunlarını önler.
// Escape + ✕ + dış tık: diğer mühendis diyaloglarıyla aynı kapanış alışkanlığı.
// Veri: GET task-history — nav state'e bağlanmaz, yalnızca okur.

import React, { useCallback, useEffect, useId, useState } from 'react';
import EngineerModal from '../engineer/EngineerModal';
import { fetchActiveMap, fetchMapTaskHistory } from '../../utils/mapApi';

// Renk: başarılı=yeşil, iptal/hata=kırmızı, başlatıldı=gri — hızlı tarama için
const STATUS_CLASS = {
  başlatıldı: 'task-history-badge--started',
  başarılı: 'task-history-badge--success',
  'iptal edildi': 'task-history-badge--fail',
  başarısız: 'task-history-badge--fail',
};

/** ISO → kısa saat; liste damgasını okunabilir tutmak için. */
function formatHistoryTime(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return String(timestamp);
  return date.toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 */
export default function TaskHistoryModal({ open, onClose }) {
  const titleId = useId();
  const [mapName, setMapName] = useState('');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const map = await fetchActiveMap();
      const history = await fetchMapTaskHistory(map.id);
      setMapName(map.name || map.id);
      setEntries(Array.isArray(history) ? history : []);
    } catch (err) {
      setEntries([]);
      setError(err.message || 'Görev geçmişi yüklenemedi.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Açılışta çek — kapalıyken gereksiz poll yok
  useEffect(() => {
    if (!open) return undefined;
    load();
    return undefined;
  }, [open, load]);

  // Escape: backdrop tıkına ek klavye çıkışı (erişilebilirlik + alışkanlık)
  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  return (
    <EngineerModal open={open} onClose={onClose} wide ariaLabelledBy={titleId}>
      <div className="task-history-modal__header">
        <h3 id={titleId} className="task-history-modal__title">
          <span aria-hidden="true">📋</span>
          <span>Görev Geçmişi</span>
          {mapName ? (
            <span className="task-history-card__map">{mapName}</span>
          ) : null}
        </h3>
        <div className="task-history-modal__actions">
          <button
            type="button"
            className="task-history-card__refresh"
            onClick={load}
            disabled={loading}
          >
            Yenile
          </button>
          <button
            type="button"
            className="task-history-modal__close"
            onClick={onClose}
            aria-label="Kapat"
          >
            ✕
          </button>
        </div>
      </div>

      {loading && <p className="task-history-empty">Yükleniyor…</p>}
      {!loading && error && <p className="task-history-error">{error}</p>}
      {!loading && !error && entries.length === 0 && (
        <p className="task-history-empty">Henüz kayıt yok.</p>
      )}

      {!loading && !error && entries.length > 0 && (
        <ul className="task-history-list" aria-label="Görev geçmişi kayıtları">
          {entries.map((entry, index) => {
            const status = entry.status || '';
            const badgeClass = STATUS_CLASS[status] || 'task-history-badge--started';
            return (
              <li
                key={`${entry.timestamp || ''}-${entry.taskName || ''}-${index}`}
                className="task-history-list__item"
              >
                <span className="task-history-list__name">{entry.taskName || '—'}</span>
                <span className={`task-history-badge ${badgeClass}`}>{status || '—'}</span>
                <time className="task-history-list__time" dateTime={entry.timestamp || undefined}>
                  {formatHistoryTime(entry.timestamp)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </EngineerModal>
  );
}
