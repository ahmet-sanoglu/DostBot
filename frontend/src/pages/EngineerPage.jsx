// Mühendis Paneli ana sayfası — PIN korumalı konum/görev/sınır yönetimi.
// PIN doğrulandıktan sonra harita verileri yüklenir; mini haritada geofence çizilebilir.

import React, { useCallback, useEffect, useState } from 'react';
import {
  createMapLocation,
  createMapTask,
  deleteMapBoundary,
  deleteMapLocation,
  deleteMapTask,
  saveMapBoundary,
  updateMapLocation,
  updateMapTask,
} from '../utils/adminApi';
import {
  fetchActiveMap,
  fetchMapBoundary,
  fetchMapLocations,
  fetchMapTasks,
} from '../utils/mapApi';
import StatusCard from '../components/dashboard/StatusCard';
import AddLocationModal from '../components/engineer/AddLocationModal';
import AddTaskModal from '../components/engineer/AddTaskModal';
import BoundarySettings from '../components/engineer/BoundarySettings';
import EngineerMiniMap from '../components/engineer/EngineerMiniMap';
import EngineerPinGate, { useEngineerAuth } from '../components/engineer/EngineerPinGate';
import MapSelectorDropdown from '../components/engineer/MapSelectorDropdown';

/** Yaw radyanını derece metnine çevirir (konum listesinde gösterim). */
function formatYawDegrees(yaw) {
  return ((yaw * 180) / Math.PI).toFixed(1);
}

/** Mühendis paneli (/muhendis) — konum, görev, geofence CRUD. */
export default function EngineerPage() {
  const { authenticated, setAuthenticated } = useEngineerAuth();
  const [activeMap, setActiveMap] = useState(null);
  const [locations, setLocations] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [boundaryPolygon, setBoundaryPolygon] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [locationModalOpen, setLocationModalOpen] = useState(false);
  const [locationModalMode, setLocationModalMode] = useState('create');
  const [editingLocation, setEditingLocation] = useState(null);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskModalMode, setTaskModalMode] = useState('create');
  const [editingTask, setEditingTask] = useState(null);
  const [locationSaving, setLocationSaving] = useState(false);
  const [taskSaving, setTaskSaving] = useState(false);
  const [locationModalError, setLocationModalError] = useState('');
  const [taskModalError, setTaskModalError] = useState('');

  const [boundaryDrawMode, setBoundaryDrawMode] = useState(false);
  const [boundaryDraft, setBoundaryDraft] = useState([]);
  const [boundaryDraftClosed, setBoundaryDraftClosed] = useState(false);
  const [boundarySaving, setBoundarySaving] = useState(false);
  const [boundaryError, setBoundaryError] = useState('');

  /** Aktif haritanın konum, görev ve sınır verilerini backend'den yeniden yükler. */
  const loadMapData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const map = await fetchActiveMap();
      const [mapLocations, mapTasks, mapBoundary] = await Promise.all([
        fetchMapLocations(map.id),
        fetchMapTasks(map.id),
        fetchMapBoundary(map.id),
      ]);
      setActiveMap(map);
      setLocations(Array.isArray(mapLocations) ? mapLocations : []);
      setTasks(Array.isArray(mapTasks) ? mapTasks : []);
      setBoundaryPolygon(mapBoundary);
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

  /** Yeni konum ekler veya düzenleme modunda mevcut konumu günceller. */
  const handleSaveLocation = async (location, mode = 'create') => {
    if (!activeMap) return false;
    setLocationSaving(true);
    setLocationModalError('');
    try {
      if (mode === 'edit' && editingLocation?.id) {
        await updateMapLocation(activeMap.id, editingLocation.id, location);
      } else {
        await createMapLocation(activeMap.id, location);
      }
      setLocationModalOpen(false);
      setEditingLocation(null);
      setLocationModalMode('create');
      await loadMapData();
      return true;
    } catch (err) {
      setLocationModalError(err.message || 'Konum kaydedilemedi.');
      return false;
    } finally {
      setLocationSaving(false);
    }
  };

  /** Konum düzenleme modalını açar — PUT sonrası backend otomatik görevi de senkronize eder. */
  const handleEditLocation = (location) => {
    setLocationModalMode('edit');
    setEditingLocation(location);
    setLocationModalError('');
    setLocationModalOpen(true);
  };

  const handleCloseLocationModal = () => {
    setLocationModalOpen(false);
    setEditingLocation(null);
    setLocationModalMode('create');
    setLocationModalError('');
  };

  const handleOpenCreateLocationModal = () => {
    setLocationModalMode('create');
    setEditingLocation(null);
    setLocationModalError('');
    setLocationModalOpen(true);
  };

  /** Konumu siler; locationId'ye bağlı otomatik tek adımlı görev de backend'de silinir. */
  const handleDeleteLocation = async (locationId) => {
    if (!activeMap) return;
    try {
      await deleteMapLocation(activeMap.id, locationId);
      await loadMapData();
    } catch (err) {
      setLoadError(err.message || 'Konum silinemedi.');
    }
  };

  /** Yeni görev ekler veya düzenleme modunda mevcut görevi günceller. */
  const handleSaveTask = async (task, mode = 'create') => {
    if (!activeMap) return false;
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
    setTaskModalMode('edit');
    setEditingTask(task);
    setTaskModalError('');
    setTaskModalOpen(true);
  };

  /** Görevi siler (onay ile). */
  const handleDeleteTask = async (taskId) => {
    if (!activeMap) return;
    if (!window.confirm('Bu görevi silmek istediğinize emin misiniz?')) {
      return;
    }
    try {
      await deleteMapTask(activeMap.id, taskId);
      await loadMapData();
    } catch (err) {
      setLoadError(err.message || 'Görev silinemedi.');
    }
  };

  const handleCloseTaskModal = () => {
    setTaskModalOpen(false);
    setEditingTask(null);
    setTaskModalMode('create');
    setTaskModalError('');
  };

  const handleOpenCreateTaskModal = () => {
    setTaskModalMode('create');
    setEditingTask(null);
    setTaskModalError('');
    setTaskModalOpen(true);
  };

  /** Mini haritada geofence poligonu çizmeye başlar. */
  const handleStartBoundaryDraw = () => {
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

  if (!authenticated) {
    return (
      <EngineerPinGate onAuthenticated={() => setAuthenticated(true)} />
    );
  }

  return (
    <div className="engineer-page">
      <div className="engineer-page__toolbar">
        <MapSelectorDropdown activeMap={activeMap} />
      </div>

      {loadError && (
        <p className="engineer-page__error">{loadError}</p>
      )}

      <div className="engineer-page__strip">
        <div className={`engineer-page__mini panel-card${boundaryDrawMode ? ' engineer-page__mini--draw' : ''}`}>
          <div className="panel-card__title panel-card__title--compact">
            <span className="panel-card__icon">🗺️</span>
            Harita
          </div>
          <EngineerMiniMap
            locations={locations}
            boundaryPolygon={boundaryPolygon}
            draftVertices={boundaryDraft}
            draftClosed={boundaryDraftClosed}
            drawMode={boundaryDrawMode}
            onVertexAdd={handleBoundaryVertexAdd}
            onDrawFinish={handleFinishBoundaryDraw}
          />
        </div>

        <div className="engineer-page__status">
          <StatusCard activeMap={activeMap} showMapName={false} />
        </div>
      </div>

      <div className="engineer-page__main">
        <section className="engineer-list panel-card">
          <div className="engineer-list__header">
            <div className="panel-card__title">
              <span className="panel-card__icon">📍</span>
              Konumlar
            </div>
            <button
              type="button"
              className="autonomous-btn autonomous-btn--small"
              onClick={handleOpenCreateLocationModal}
            >
              + Ekle
            </button>
          </div>

          {loading ? (
            <p className="autonomous-panel__meta">Yükleniyor…</p>
          ) : locations.length === 0 ? (
            <p className="autonomous-panel__meta">Henüz konum tanımlı değil.</p>
          ) : (
            <ul className="engineer-list__items">
              {locations.map((location) => (
                <li key={location.id} className="engineer-list__item">
                  <div>
                    <strong>{location.name}</strong>
                    <p className="autonomous-panel__meta">
                      X {location.x.toFixed(2)} m · Y {location.y.toFixed(2)} m · Yaw {formatYawDegrees(location.yaw)}°
                    </p>
                  </div>
                  {/* Düzenle/Sil: mühendis CRUD — operatör panelindeki konum/görev listesini günceller */}
                  <div className="engineer-list__item-actions">
                    <button
                      type="button"
                      className="autonomous-btn autonomous-btn--ghost autonomous-btn--small"
                      onClick={() => handleEditLocation(location)}
                    >
                      Düzenle
                    </button>
                    <button
                      type="button"
                      className="autonomous-btn autonomous-btn--ghost autonomous-btn--small"
                      onClick={() => handleDeleteLocation(location.id)}
                    >
                      Sil
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="engineer-list panel-card">
          <div className="engineer-list__header">
            <div className="panel-card__title">
              <span className="panel-card__icon">🎯</span>
              Görevler
            </div>
            <div className="engineer-list__header-actions">
              <p className="engineer-list__hint">
                Koordinat adımları ve görev bitince eylem tanımlayın.
                Tek nokta görevleri, konum eklendiğinde otomatik oluşturulur.
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
                      onClick={() => handleDeleteTask(task.id)}
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
        </section>
      </div>

      <AddLocationModal
        open={locationModalOpen}
        onClose={handleCloseLocationModal}
        onSave={handleSaveLocation}
        saving={locationSaving}
        error={locationModalError}
        mode={locationModalMode}
        initialLocation={editingLocation}
      />

      <AddTaskModal
        open={taskModalOpen}
        onClose={handleCloseTaskModal}
        onSave={handleSaveTask}
        saving={taskSaving}
        error={taskModalError}
        mode={taskModalMode}
        initialTask={editingTask}
      />
    </div>
  );
}
