// Operatör Kontrol Paneli ana sayfası — sol harita, sağ kontrol kartları.
// Görev başlatmadan önce isWorldGoalPassable ile hedef doğrulanır.

import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import MapView from '../components/MapView';
import ControlPanel from '../components/dashboard/ControlPanel';
import TelemetryPanel from '../components/dashboard/TelemetryPanel';
import { useActiveMap } from '../hooks/useActiveMap';
import { useMapOccupancy } from '../hooks/useMapOccupancy';
import { useNavigation } from '../context/NavigationContext';

/** Kontrol Paneli (/) — harita + görev/joystick paneli bir arada. */
export default function DashboardPage() {
  const [searchParams] = useSearchParams();
  const showDebugTelemetry = searchParams.get('debug') === '1';
  const {
    activeMap,
    tasks,
    setTasks,
    forbiddenZones,
    boundaryPolygon,
    loading: mapDataLoading,
    error: mapDataError,
  } = useActiveMap();
  const { mapReady, isGoalPassable } = useMapOccupancy(forbiddenZones, boundaryPolygon);
  const {
    lastSentGoal,
    queueBusy,
    showBusyPopup,
    setShowBusyPopup,
    startTask,
  } = useNavigation();
  const [showInvalidGoalPopup, setShowInvalidGoalPopup] = useState(false);

  /**
   * Görev Başlat öncesi geofence zinciri (isWorldGoalPassable / mapPassability.js):
   * 1) Occupancy piksel — duvar/engel/bilinmeyen gri alan elenir (harita verisi)
   * 2) Geofence poligonu — mühendisin çizdiği sınır dışı elenir
   * 3) Yasak dikdörtgen — forbidden_zones.json ile tanımlı bölgeler elenir
   * Sıra: ucuz harita kontrolü önce; mühendis kısıtları en sonda uygulanır.
   * Till onayı ControlPanel'de bu kontrolden sonra, startTask'tan önce sorulur.
   */
  const validateTaskGoals = useCallback((task) => {
    if (!mapReady) return false;

    const steps = Array.isArray(task.steps) ? task.steps : [];
    for (const step of steps) {
      if (typeof step?.x !== 'number' || typeof step?.y !== 'number') {
        continue;
      }
      if (!isGoalPassable(step.x, step.y)) {
        setShowInvalidGoalPopup(true);
        return false;
      }
    }

    return true;
  }, [isGoalPassable, mapReady]);

  const handleStartTask = useCallback((task) => {
    if (!validateTaskGoals(task)) return false;
    return startTask(task);
  }, [startTask, validateTaskGoals]);

  return (
    <div className={`main-content${showDebugTelemetry ? ' main-content--debug' : ''}`}>
      <div className="map-column">
        <div className="map-panel">
          <MapView />
        </div>
      </div>

      <ControlPanel
        activeMap={activeMap}
        tasks={tasks}
        onTasksChange={setTasks}
        tasksLoading={mapDataLoading}
        tasksError={mapDataError}
        mapReady={mapReady}
        onValidateTask={validateTaskGoals}
        onStartTask={handleStartTask}
        lastSentGoal={lastSentGoal}
        queueBusy={queueBusy}
        showBusyPopup={showBusyPopup}
        onCloseBusyPopup={() => setShowBusyPopup(false)}
        showInvalidGoalPopup={showInvalidGoalPopup}
        onCloseInvalidGoalPopup={() => setShowInvalidGoalPopup(false)}
      />

      {showDebugTelemetry && (
        <TelemetryPanel debugMode />
      )}
    </div>
  );
}
