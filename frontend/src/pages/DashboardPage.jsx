import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import MapView from '../components/MapView';
import ControlPanel from '../components/dashboard/ControlPanel';
import TelemetryPanel from '../components/dashboard/TelemetryPanel';
import { useActiveMap } from '../hooks/useActiveMap';
import { useMapOccupancy } from '../hooks/useMapOccupancy';
import { useNavigation } from '../context/NavigationContext';

export default function DashboardPage() {
  const [searchParams] = useSearchParams();
  const showDebugTelemetry = searchParams.get('debug') === '1';
  const {
    activeMap,
    tasks,
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

  const handleStartTask = useCallback((task) => {
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

    return startTask(task);
  }, [isGoalPassable, mapReady, startTask]);

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
        tasksLoading={mapDataLoading}
        tasksError={mapDataError}
        mapReady={mapReady}
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
