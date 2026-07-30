// Mühendis paneli harita seçici — ekle / aktif yap / sil.
// Neden reload: aktif harita değişince imageDir + tasks hepsi baştan yüklenmeli;
// kısmi state güncellemesi eski harita verisini karıştırırdı.
// Sil: ConfirmDialog — geri alınamaz görev silinmesini yanlış tıklamayla engellemek için.
// Aktif harita ve map_default UI'da Sil yok (backend de reddeder).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { activateMap, createMap, deleteMap } from '../../utils/adminApi';
import { fetchMaps } from '../../utils/mapApi';
import ConfirmDialog from './ConfirmDialog';
import EngineerModal from './EngineerModal';

/** Ana sera kaydı — UI'da Sil butonu gizlenir; backend PROTECTED_MAP_ID ile uyumlu. */
const PROTECTED_MAP_ID = 'map_default';

export default function MapSelectorDropdown({ activeMap }) {
  const [open, setOpen] = useState(false);
  const [maps, setMaps] = useState([]);
  const [listError, setListError] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [sourceDir, setSourceDir] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [activatingId, setActivatingId] = useState(null);
  const [confirmMap, setConfirmMap] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const rootRef = useRef(null);

  const loadMaps = useCallback(async () => {
    try {
      const data = await fetchMaps();
      setMaps(Array.isArray(data) ? data : []);
      setListError(null);
    } catch (err) {
      setListError(err.message || 'Haritalar yüklenemedi');
    }
  }, []);

  // Menü açılınca listeyi tazele — yeni eklenen haritalar hemen görünsün.
  useEffect(() => {
    if (!open) return undefined;
    loadMaps();
    return undefined;
  }, [open, loadMaps]);

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

  // Modal her açılışında formu sıfırla.
  useEffect(() => {
    if (!addOpen) return;
    setName('');
    setSourceDir('');
    setFormError(null);
  }, [addOpen]);

  const handleOpenAdd = () => {
    setOpen(false);
    setAddOpen(true);
  };

  // Kaynak klasör doğrulaması backend'de; burada sadece form → createMap.
  const handleCreate = async (event) => {
    event.preventDefault();
    if (!name.trim() || !sourceDir.trim() || saving) return;

    setSaving(true);
    setFormError(null);
    try {
      await createMap(name.trim(), sourceDir.trim());
      setAddOpen(false);
      setOpen(true); // listeyi yeniden göstermek için
      await loadMaps();
    } catch (err) {
      setFormError(err.message || 'Harita eklenemedi');
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async (mapId) => {
    if (activatingId) return;
    setActivatingId(mapId);
    try {
      await activateMap(mapId);
      // Full reload: eski haritanın görev/görsel state'i bellekte kalmasın.
      window.location.reload();
    } catch (err) {
      setListError(err.message || 'Harita aktifleştirilemedi');
      setActivatingId(null);
    }
  };

  const handleRequestDelete = (map) => {
    setOpen(false);
    setConfirmMap(map); // ConfirmDialog aç — doğrudan DELETE yok
  };

  const handleConfirmDelete = async () => {
    if (!confirmMap || deleting) return;
    setDeleting(true);
    try {
      await deleteMap(confirmMap.id);
      setConfirmMap(null);
      setOpen(true);
      await loadMaps();
    } catch (err) {
      setListError(err.message || 'Harita silinemedi');
      setConfirmMap(null);
      setOpen(true);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
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
            {listError && (
              <li className="engineer-map-selector__item engineer-map-selector__item--error">
                {listError}
              </li>
            )}
            {maps.map((map) => {
              const isActive = map.isActive === true || map.id === activeMap?.id;
              const canDelete = !isActive && map.id !== PROTECTED_MAP_ID;
              return (
                <li
                  key={map.id}
                  className={`engineer-map-selector__item${isActive ? ' engineer-map-selector__item--active' : ''}`}
                  role="option"
                  aria-selected={isActive}
                >
                  <span className="engineer-map-selector__row">
                    {isActive && (
                      <span className="engineer-map-selector__check" aria-hidden="true">✓</span>
                    )}
                    <span className="engineer-map-selector__name">{map.name}</span>
                    {!isActive && (
                      <button
                        type="button"
                        className="engineer-map-selector__activate"
                        disabled={Boolean(activatingId) || deleting}
                        onClick={() => handleActivate(map.id)}
                      >
                        {activatingId === map.id ? '…' : 'Aktif Yap'}
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        className="engineer-map-selector__delete"
                        disabled={deleting || Boolean(activatingId)}
                        onClick={() => handleRequestDelete(map)}
                      >
                        Sil
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
            <li className="engineer-map-selector__item engineer-map-selector__item--action">
              <button
                type="button"
                className="engineer-map-selector__add"
                onClick={handleOpenAdd}
              >
                + Yeni Harita Ekle
              </button>
            </li>
          </ul>
        )}
      </div>

      <EngineerModal
        open={addOpen}
        onClose={() => !saving && setAddOpen(false)}
        ariaLabelledBy="add-map-title"
      >
        <h3 id="add-map-title">Yeni Harita Ekle</h3>
        <p className="engineer-modal__intro">
          Kaynak klasörde map.yaml ve map.pgm (veya map.png) bulunmalıdır.
        </p>
        <form className="engineer-form" onSubmit={handleCreate}>
          <label className="engineer-form__field engineer-form__field--full">
            <span>Harita Adı</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Örn. Simülasyon Haritası"
              required
              disabled={saving}
            />
          </label>
          <label className="engineer-form__field engineer-form__field--full">
            <span>Kaynak Klasör Yolu</span>
            <input
              type="text"
              value={sourceDir}
              onChange={(e) => setSourceDir(e.target.value)}
              placeholder="/home/ahmet/AgriFleet/turtlebot3_sim_map"
              required
              disabled={saving}
            />
          </label>
          {formError && <p className="engineer-form__error">{formError}</p>}
          <div className="engineer-form__actions">
            <button
              type="button"
              className="autonomous-btn autonomous-btn--ghost"
              onClick={() => setAddOpen(false)}
              disabled={saving}
            >
              İptal
            </button>
            <button
              type="submit"
              className="autonomous-btn"
              disabled={saving || !name.trim() || !sourceDir.trim()}
            >
              {saving ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          </div>
        </form>
      </EngineerModal>

      <ConfirmDialog
        open={Boolean(confirmMap)}
        title="Haritayı Sil"
        message={
          confirmMap
            ? `${confirmMap.name} haritasını silmek istediğinize emin misiniz? Bu haritaya ait tüm görevler de silinecek. Bu işlem geri alınamaz.`
            : ''
        }
        onConfirm={handleConfirmDelete}
        onCancel={() => !deleting && setConfirmMap(null)}
      />
    </>
  );
}
