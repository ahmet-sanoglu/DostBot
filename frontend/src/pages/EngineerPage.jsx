// Mühendis Paneli ana sayfası — PIN korumalı görev/sınır/yasak bölge yönetimi.
// PIN doğrulandıktan sonra harita verileri yüklenir; mini haritada geofence çizilebilir.
// Kaydırma: .engineer-page height:100% + overflow-y:auto (App.css) — üstteki
// .workspace__content overflow:hidden olduğu için içerik uzayınca sayfa kayamazdı;
// sabit 100vh yerine esnek yükseklik + iç scroll ile Ayarlar kartı erişilebilir kalır.
// Layout (engineer-page__body): sol harita+kamera | sağ blok — dashboard main-content gibi;
// sağda Durum üstte, Görevler+Ayarlar altta yan yana — harita sürekli görünür kalsın,
// üç eşit sütunda kartların sıkışıp kaybolmasını önlemek için.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  createForbiddenZone,
  createMapTask,
  deleteForbiddenZone,
  deleteMapBoundary,
  deleteMapTask,
  saveMapBoundary,
  updateMapTask,
} from '../utils/adminApi';
import {
  fetchActiveMap,
  fetchMapBoundary,
  fetchMapForbiddenZones,
  fetchMapTasks,
} from '../utils/mapApi';
import StatusCard from '../components/dashboard/StatusCard';
import CameraFeed from '../components/CameraFeed';
import AddTaskModal from '../components/engineer/AddTaskModal';
import BoundarySettings from '../components/engineer/BoundarySettings';
import ConfirmDialog from '../components/engineer/ConfirmDialog';
import ForbiddenZoneSettings from '../components/engineer/ForbiddenZoneSettings';
import EngineerMiniMap from '../components/engineer/EngineerMiniMap';
import EngineerPinGate, { useEngineerAuth } from '../components/engineer/EngineerPinGate';
import MapSelectorDropdown from '../components/engineer/MapSelectorDropdown';
import UndoToast from '../components/engineer/UndoToast';

/** ConfirmDialog mesajı — görev silme onayı. */
function buildDeleteConfirmMessage(target) {
  if (!target) return '';
  return `"${target.name}" adlı görevi silmek istediğinize emin misiniz? Bu işlem geri alınamaz.`;
}

/** Geri alma POST'u için id'siz görev gövdesi. */
function toTaskCreatePayload(task) {
  const payload = {
    name: task.name,
    steps: (Array.isArray(task.steps) ? task.steps : []).map((step) => ({
      x: step.x,
      y: step.y,
      yaw: step.yaw,
      action: { type: step.action?.type || 'wait' },
    })),
  };
  if (typeof task.description === 'string' && task.description.trim()) {
    payload.description = task.description.trim();
  }
  return payload;
}

/** Mühendis paneli (/muhendis) — görev, geofence, yasak bölge CRUD. */
export default function EngineerPage() {
  const { authenticated, setAuthenticated } = useEngineerAuth();
  const [activeMap, setActiveMap] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [boundaryPolygon, setBoundaryPolygon] = useState(null);
  const [forbiddenZones, setForbiddenZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskModalMode, setTaskModalMode] = useState('create');
  const [editingTask, setEditingTask] = useState(null);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskModalError, setTaskModalError] = useState('');

  const [boundaryDrawMode, setBoundaryDrawMode] = useState(false);
  const [boundaryDraft, setBoundaryDraft] = useState([]);
  const [boundaryDraftClosed, setBoundaryDraftClosed] = useState(false);
  const [boundarySaving, setBoundarySaving] = useState(false);
  const [boundaryError, setBoundaryError] = useState('');
  /** Yasak dikdörtgen çizimi — geofence drawMode'dan ayrı state; aynı anda karışmasın diye. */
  const [forbiddenDrawMode, setForbiddenDrawMode] = useState(false);
  /** İlk köşe; ikinci tıklamada pendingRect üretilir, sonra isim formu açılır. */
  const [forbiddenCorner, setForbiddenCorner] = useState(null);
  /** İsim bekleyen dikdörtgen (xMin..yMax); çizim bitince set edilir. */
  const [forbiddenPendingRect, setForbiddenPendingRect] = useState(null);
  const [zoneSaving, setZoneSaving] = useState(false);
  const [zoneError, setZoneError] = useState('');
  /** Silinecek görev; null = ConfirmDialog kapalı. */
  const [confirmTarget, setConfirmTarget] = useState(null);
  /** Undo toast görünür metni: { name } veya null */
  const [undoToast, setUndoToast] = useState(null);
  /**
   * Geri alma için silinen nesnenin snapshot'ı (DELETE öncesi kopya).
   * Toast 6 sn veya yeni bir mühendis işlemi gelince clearPendingUndo ile düşer — süre dolunca POST yapılamaz.
   */
  const pendingUndoRef = useRef(null);
  const mapCardRef = useRef(null);
  /** Harita kartının ölçülen dış boyutu — kamera kartına sabit px olarak kopyalanır. */
  const [mapCardSize, setMapCardSize] = useState(null);

  const clearPendingUndo = useCallback(() => {
    pendingUndoRef.current = null;
    setUndoToast(null);
  }, []);

  /** Aktif haritanın görev, sınır ve yasak bölge verilerini backend'den yeniden yükler. */
  const loadMapData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const map = await fetchActiveMap();
      const [mapTasks, mapBoundary, mapForbiddenZones] = await Promise.all([
        fetchMapTasks(map.id),
        fetchMapBoundary(map.id),
        fetchMapForbiddenZones(map.id),
      ]);
      setActiveMap(map);
      setTasks(Array.isArray(mapTasks) ? mapTasks : []);
      setBoundaryPolygon(mapBoundary);
      setForbiddenZones(Array.isArray(mapForbiddenZones) ? mapForbiddenZones : []);
    } catch (err) {
      setLoadError(err.message || 'Harita verileri yüklenemedi.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authenticated) {
      loadMapData();
    }
  }, [authenticated, loadMapData]);

  // Harita kartı yüksekliği → kamera kartına (genişlik flex ile paylaşılır).
  // Neden? Kamera haritadan kısa kalmasın / wrap ile alta düşmesin; yan yana eşit yükseklik.
  useEffect(() => {
    if (!authenticated) return undefined;
    const el = mapCardRef.current;
    if (!el) return undefined;

    const syncSize = () => {
      const width = Math.round(el.offsetWidth);
      const height = Math.round(el.offsetHeight);
      if (width <= 0 || height <= 0) return;
      setMapCardSize((prev) => (
        prev && prev.width === width && prev.height === height
          ? prev
          : { width, height }
      ));
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [authenticated, boundaryDrawMode, forbiddenDrawMode, loading, activeMap?.id]);

  /** Yeni görev ekler veya düzenleme modunda mevcut görevi günceller. */
  const handleSaveTask = async (task, mode = 'create') => {
    if (!activeMap) return false;
    clearPendingUndo();
    setTaskSaving(true);
    setTaskModalError('');
    try {
      if (mode === 'edit' && editingTask?.id) {
        await updateMapTask(activeMap.id, editingTask.id, task);
      } else {
        await createMapTask(activeMap.id, task);
      }
      setTaskModalOpen(false);
      setEditingTask(null);
      setTaskModalMode('create');
      await loadMapData();
      return true;
    } catch (err) {
      setTaskModalError(err.message || 'Görev kaydedilemedi.');
      return false;
    } finally {
      setTaskSaving(false);
    }
  };

  /** Görev düzenleme modalını açar. */
  const handleEditTask = (task) => {
    clearPendingUndo();
    setTaskModalMode('edit');
    setEditingTask(task);
    setTaskModalError('');
    setTaskModalOpen(true);
  };

  /** Görevi siler. */
  const handleDeleteTask = async (taskId) => {
    if (!activeMap) return;
    try {
      await deleteMapTask(activeMap.id, taskId);
      await loadMapData();
    } catch (err) {
      setLoadError(err.message || 'Görev silinemedi.');
      throw err;
    }
  };

  /** Sil butonu → ConfirmDialog aç; silme API'si burada çağrılmaz (yanlış tıklamayı önlemek için). */
  const requestDeleteTask = (task) => {
    clearPendingUndo();
    setConfirmTarget({
      type: 'task',
      id: task.id,
      name: task.name || 'Görev',
    });
  };

  /**
   * ConfirmDialog "Sil": önce snapshot → DELETE → toast.
   * Snapshot DELETE'ten önce alınır; geri alma yeni POST ile (yeni id) yeniden oluşturur.
   */
  const handleConfirmDelete = async () => {
    if (!confirmTarget || !activeMap) return;

    const { id } = confirmTarget;
    const entity = tasks.find((task) => task.id === id);

    setConfirmTarget(null);
    if (!entity) return;

    const snapshot = JSON.parse(JSON.stringify(entity));
    const displayName = entity.name || 'Görev';

    try {
      await handleDeleteTask(id);
      pendingUndoRef.current = { type: 'task', data: snapshot };
      setUndoToast({ name: displayName });
    } catch {
      // Hata mesajı delete handler'da setLoadError ile yazıldı
      clearPendingUndo();
    }
  };

  /** Toast "Geri Al": pendingUndoRef'teki snapshot ile POST; id bilerek gönderilmez (backend yeni üretir). */
  const handleUndoDelete = async () => {
    const pending = pendingUndoRef.current;
    if (!pending || !activeMap) return;

    clearPendingUndo();
    try {
      if (pending.type === 'task') {
        await createMapTask(activeMap.id, toTaskCreatePayload(pending.data));
      }
      await loadMapData();
    } catch (err) {
      setLoadError(err.message || 'Geri alma başarısız.');
    }
  };

  const handleCloseTaskModal = () => {
    setTaskModalOpen(false);
    setEditingTask(null);
    setTaskModalMode('create');
    setTaskModalError('');
  };

  const handleOpenCreateTaskModal = () => {
    clearPendingUndo();
    setTaskModalMode('create');
    setEditingTask(null);
    setTaskModalError('');
    setTaskModalOpen(true);
  };

  /** Mini haritada geofence poligonu çizmeye başlar. */
  const handleStartBoundaryDraw = () => {
    clearPendingUndo();
    // Yasak bölge çizimi açıksa kapat — iki mod aynı anda çalışmasın
    setForbiddenDrawMode(false);
    setForbiddenCorner(null);
    setForbiddenPendingRect(null);
    setZoneError('');
    setBoundaryError('');
    setBoundaryDrawMode(true);
    setBoundaryDraft([]);
    setBoundaryDraftClosed(false);
  };

  /** Çizim modunda haritaya tıklanan noktayı taslak köşe listesine ekler. */
  const handleBoundaryVertexAdd = (point) => {
    setBoundaryDraft((prev) => [...prev, { x: point.x, y: point.y }]);
  };

  /** En az 3 köşe varsa çizimi kapatır; Kaydet butonu görünür hale gelir. */
  const handleFinishBoundaryDraw = () => {
    if (boundaryDraft.length < 3) return;
    setBoundaryDrawMode(false);
    setBoundaryDraftClosed(true);
  };

  /** Çizim modunu iptal eder, taslak köşeleri temizler. */
  const handleCancelBoundaryDraw = () => {
    setBoundaryDrawMode(false);
    setBoundaryDraft([]);
    setBoundaryDraftClosed(false);
    setBoundaryError('');
  };

  /** Taslak poligonu boundary.json olarak backend'e yazar. */
  const handleSaveBoundary = async () => {
    if (!activeMap || boundaryDraft.length < 3) return;
    clearPendingUndo();
    setBoundarySaving(true);
    setBoundaryError('');
    try {
      await saveMapBoundary(activeMap.id, boundaryDraft);
      setBoundaryDraft([]);
      setBoundaryDraftClosed(false);
      await loadMapData();
    } catch (err) {
      setBoundaryError(err.message || 'Sınır kaydedilemedi.');
    } finally {
      setBoundarySaving(false);
    }
  };

  /** Kayıtlı geofence sınırını backend'den kaldırır. */
  const handleDeleteBoundary = async () => {
    if (!activeMap) return;
    clearPendingUndo();
    setBoundarySaving(true);
    setBoundaryError('');
    try {
      await deleteMapBoundary(activeMap.id);
      setBoundaryDraft([]);
      setBoundaryDraftClosed(false);
      await loadMapData();
    } catch (err) {
      setBoundaryError(err.message || 'Sınır silinemedi.');
    } finally {
      setBoundarySaving(false);
    }
  };

  /** Yasak dikdörtgen çizimine başlar (2 tık); geofence çizimini kapatır. */
  const handleStartForbiddenDraw = () => {
    clearPendingUndo();
    setBoundaryDrawMode(false);
    setBoundaryDraft([]);
    setBoundaryDraftClosed(false);
    setBoundaryError('');
    setZoneError('');
    setForbiddenPendingRect(null);
    setForbiddenCorner(null);
    setForbiddenDrawMode(true);
  };

  const handleCancelForbiddenDraw = () => {
    setForbiddenDrawMode(false);
    setForbiddenCorner(null);
    setForbiddenPendingRect(null);
    setZoneError('');
  };

  /**
   * Yasak bölge tıklaması: 1. köşe saklanır, 2. köşe dikdörtgeni bitirir → isim formu.
   * Aynı nokta (sıfır alan) yok sayılır.
   */
  const handleForbiddenCornerClick = (point) => {
    if (!forbiddenCorner) {
      setForbiddenCorner({ x: point.x, y: point.y });
      return;
    }

    const xMin = Math.min(forbiddenCorner.x, point.x);
    const xMax = Math.max(forbiddenCorner.x, point.x);
    const yMin = Math.min(forbiddenCorner.y, point.y);
    const yMax = Math.max(forbiddenCorner.y, point.y);

    if (!(xMin < xMax && yMin < yMax)) {
      return;
    }

    setForbiddenPendingRect({ xMin, xMax, yMin, yMax });
    setForbiddenDrawMode(false);
    setForbiddenCorner(null);
  };

  const handleCancelForbiddenPending = () => {
    setForbiddenPendingRect(null);
    setZoneError('');
  };

  /** İsim + çizilen dikdörtgen → createForbiddenZone. */
  const handleSaveForbiddenPending = async (zone) => {
    if (!activeMap) return false;
    clearPendingUndo();
    setZoneSaving(true);
    setZoneError('');
    try {
      await createForbiddenZone(activeMap.id, zone);
      setForbiddenPendingRect(null);
      await loadMapData();
      return true;
    } catch (err) {
      setZoneError(err.message || 'Yasaklı bölge kaydedilemedi.');
      return false;
    } finally {
      setZoneSaving(false);
    }
  };

  /** Tek yasak bölgeyi siler (ConfirmDialog onayı ForbiddenZoneSettings içinde). */
  const handleDeleteForbiddenZone = async (zoneId) => {
    if (!activeMap) return;
    clearPendingUndo();
    setZoneSaving(true);
    setZoneError('');
    try {
      await deleteForbiddenZone(activeMap.id, zoneId);
      await loadMapData();
    } catch (err) {
      setZoneError(err.message || 'Yasaklı bölge silinemedi.');
    } finally {
      setZoneSaving(false);
    }
  };

  const mapDrawActive = boundaryDrawMode || forbiddenDrawMode;

  if (!authenticated) {
    return (
      <EngineerPinGate onAuthenticated={() => setAuthenticated(true)} />
    );
  }

  return (
    // Kaydırma kabı: class App.css'te height/overflow ile tanımlı — parent clip'ini aşmak için
    <div className="engineer-page">
      <div className="engineer-page__toolbar">
        <MapSelectorDropdown activeMap={activeMap} />
      </div>

      {loadError && (
        <p className="engineer-page__error">{loadError}</p>
      )}

      {/* Dış grid: sol harita|kamera yan yana; sağ Durum / Görevler|Ayarlar */}
      <div className="engineer-page__body">
        <div className="engineer-page__visuals">
          {/* Kart genişliği → mini harita ResizeObserver (sabit 340px yok) */}
          <div
            ref={mapCardRef}
            className={`engineer-page__map panel-card${mapDrawActive ? ' engineer-page__map--draw' : ''}`}
          >
            <div className="panel-card__title panel-card__title--compact">
              <span className="panel-card__icon">🗺️</span>
              Harita
            </div>
            <EngineerMiniMap
              boundaryPolygon={boundaryPolygon}
              draftVertices={boundaryDraft}
              draftClosed={boundaryDraftClosed}
              drawMode={boundaryDrawMode}
              onVertexAdd={handleBoundaryVertexAdd}
              onDrawFinish={handleFinishBoundaryDraw}
              forbiddenZones={forbiddenZones}
              forbiddenDrawMode={forbiddenDrawMode}
              forbiddenCorner={forbiddenCorner}
              forbiddenDraftRect={forbiddenPendingRect}
              onForbiddenCornerClick={handleForbiddenCornerClick}
            />
          </div>

          {/* Yükseklik haritadan; genişlik flex ile eşit paylaşılır (wrap düşmesin) */}
          <div
            className="engineer-page__camera panel-card"
            style={mapCardSize ? {
              height: mapCardSize.height,
              maxHeight: mapCardSize.height,
            } : undefined}
          >
            <div className="panel-card__title panel-card__title--compact">
              <span className="panel-card__icon">📷</span>
              Kamera
            </div>
            <CameraFeed className="engineer-page__camera-feed" />
          </div>
        </div>

        <div className="engineer-page__side">
          <div className="engineer-page__status">
            <StatusCard activeMap={activeMap} showMapName={false} />
          </div>

          <div className="engineer-page__side-main">
            <section className="engineer-list panel-card">
              <div className="engineer-list__header">
                <div className="panel-card__title">
                  <span className="panel-card__icon">🎯</span>
                  Görevler
                </div>
                <div className="engineer-list__header-actions">
                  <p className="engineer-list__hint">
                    Koordinat adımları ve her adımda eylem tanımlayın (Bekle / Toprağı Sür).
                  </p>
                  <button
                    type="button"
                    className="autonomous-btn autonomous-btn--small"
                    onClick={handleOpenCreateTaskModal}
                  >
                    + Ekle
                  </button>
                </div>
              </div>

              {loading ? (
                <p className="autonomous-panel__meta">Yükleniyor…</p>
              ) : tasks.length === 0 ? (
                <p className="autonomous-panel__meta">Henüz görev tanımlı değil.</p>
              ) : (
                <ul className="engineer-list__items">
                  {tasks.map((task) => (
                    <li key={task.id} className="engineer-list__item">
                      <div>
                        <strong>{task.name}</strong>
                        {task.description && (
                          <p className="autonomous-panel__meta">{task.description}</p>
                        )}
                        <p className="autonomous-panel__meta">
                          {Array.isArray(task.steps) ? task.steps.length : 0} adım
                        </p>
                      </div>
                      {/* Düzenle/Sil: görev CRUD — step action'ları operatör Başlat zincirini etkiler */}
                      <div className="engineer-list__item-actions">
                        <button
                          type="button"
                          className="autonomous-btn autonomous-btn--ghost autonomous-btn--small"
                          onClick={() => handleEditTask(task)}
                        >
                          Düzenle
                        </button>
                        <button
                          type="button"
                          className="autonomous-btn autonomous-btn--ghost autonomous-btn--small"
                          onClick={() => requestDeleteTask(task)}
                        >
                          Sil
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="engineer-list panel-card engineer-list--settings">
              <div className="engineer-list__header">
                <div className="panel-card__title">
                  <span className="panel-card__icon">⚙️</span>
                  Ayarlar
                </div>
              </div>
              <div className="engineer-settings__section">
                <BoundarySettings
                  boundaryPolygon={boundaryPolygon}
                  drawMode={boundaryDrawMode}
                  draftVertices={boundaryDraft}
                  draftClosed={boundaryDraftClosed}
                  saving={boundarySaving}
                  error={boundaryError}
                  onStartDraw={handleStartBoundaryDraw}
                  onFinishDraw={handleFinishBoundaryDraw}
                  onCancelDraw={handleCancelBoundaryDraw}
                  onSave={handleSaveBoundary}
                  onDelete={handleDeleteBoundary}
                />
              </div>
              <div className="engineer-settings__section">
                <ForbiddenZoneSettings
                  zones={forbiddenZones}
                  saving={zoneSaving}
                  error={zoneError}
                  drawMode={forbiddenDrawMode}
                  pendingRect={forbiddenPendingRect}
                  onStartDraw={handleStartForbiddenDraw}
                  onCancelDraw={handleCancelForbiddenDraw}
                  onSavePending={handleSaveForbiddenPending}
                  onCancelPending={handleCancelForbiddenPending}
                  onDelete={handleDeleteForbiddenZone}
                />
              </div>
            </section>
          </div>
        </div>
      </div>

      <AddTaskModal
        open={taskModalOpen}
        onClose={handleCloseTaskModal}
        onSave={handleSaveTask}
        saving={taskSaving}
        error={taskModalError}
        mode={taskModalMode}
        initialTask={editingTask}
      />

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        title="Görev Sil"
        message={buildDeleteConfirmMessage(confirmTarget)}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmTarget(null)}
      />

      <UndoToast
        open={Boolean(undoToast)}
        message={undoToast ? `${undoToast.name} silindi` : ''}
        onUndo={handleUndoDelete}
        onDismiss={clearPendingUndo}
      />
    </div>
  );
}
