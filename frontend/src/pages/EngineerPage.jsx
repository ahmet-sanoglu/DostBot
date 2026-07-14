import React, { useCallback, useEffect, useState } from 'react';
import {
  createMapLocation,
  createMapTask,
  deleteMapBoundary,
  deleteMapLocation,
  saveMapBoundary,
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

function formatYawDegrees(yaw) {
  return ((yaw * 180) / Math.PI).toFixed(1);
}

export default function EngineerPage() {
  const { authenticated, setAuthenticated } = useEngineerAuth();
  const [activeMap, setActiveMap] = useState(null);
  const [locations, setLocations] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [boundaryPolygon, setBoundaryPolygon] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [locationModalOpen, setLocationModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [locationSaving, setLocationSaving] = useState(false);
  const [taskSaving, setTaskSaving] = useState(false);
  const [locationModalError, setLocationModalError] = useState('');
  const [taskModalError, setTaskModalError] = useState('');

  const [boundaryDrawMode, setBoundaryDrawMode] = useState(false);
  const [boundaryDraft, setBoundaryDraft] = useState([]);
  const [boundaryDraftClosed, setBoundaryDraftClosed] = useState(false);
  const [boundarySaving, setBoundarySaving] = useState(false);
  const [boundaryError, setBoundaryError] = useState('');

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

  const handleSaveLocation = async (location) => {
    if (!activeMap) return false;
    setLocationSaving(true);
    setLocationModalError('');
    try {
      await createMapLocation(activeMap.id, location);
      setLocationModalOpen(false);
      await loadMapData();
      return true;
    } catch (err) {
      setLocationModalError(err.message || 'Konum kaydedilemedi.');
      return false;
    } finally {
      setLocationSaving(false);
    }
  };

  const handleDeleteLocation = async (locationId) => {
    if (!activeMap) return;
    try {
      await deleteMapLocation(activeMap.id, locationId);
      await loadMapData();
    } catch (err) {
      setLoadError(err.message || 'Konum silinemedi.');
    }
  };

  const handleSaveTask = async (task) => {
    if (!activeMap) return false;
    setTaskSaving(true);
    setTaskModalError('');
    try {
      await createMapTask(activeMap.id, task);
      setTaskModalOpen(false);
      await loadMapData();
      return true;
    } catch (err) {
      setTaskModalError(err.message || 'Görev kaydedilemedi.');
      return false;
    } finally {
      setTaskSaving(false);
    }
  };

  const handleStartBoundaryDraw = () => {
    setBoundaryError('');
    setBoundaryDrawMode(true);
    setBoundaryDraft([]);
    setBoundaryDraftClosed(false);
  };

  const handleBoundaryVertexAdd = (point) => {
    setBoundaryDraft((prev) => [...prev, { x: point.x, y: point.y }]);
  };

  const handleFinishBoundaryDraw = () => {
    if (boundaryDraft.length < 3) return;
    setBoundaryDrawMode(false);
    setBoundaryDraftClosed(true);
  };

  const handleCancelBoundaryDraw = () => {
    setBoundaryDrawMode(false);
    setBoundaryDraft([]);
    setBoundaryDraftClosed(false);
    setBoundaryError('');
  };

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
              onClick={() => {
                setLocationModalError('');
                setLocationModalOpen(true);
              }}
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
                  <button
                    type="button"
                    className="autonomous-btn autonomous-btn--ghost autonomous-btn--small"
                    onClick={() => handleDeleteLocation(location.id)}
                  >
                    Sil
                  </button>
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
            <button
              type="button"
              className="autonomous-btn autonomous-btn--small"
              onClick={() => {
                setTaskModalError('');
                setTaskModalOpen(true);
              }}
            >
              + Ekle
            </button>
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
                    <p className="autonomous-panel__meta">
                      {Array.isArray(task.steps) ? task.steps.length : 0} adım
                    </p>
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
        onClose={() => setLocationModalOpen(false)}
        onSave={handleSaveLocation}
        saving={locationSaving}
        error={locationModalError}
      />

      <AddTaskModal
        open={taskModalOpen}
        locations={locations}
        onClose={() => setTaskModalOpen(false)}
        onSave={handleSaveTask}
        saving={taskSaving}
        error={taskModalError}
      />
    </div>
  );
}
