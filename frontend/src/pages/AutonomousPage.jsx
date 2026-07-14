import React, { useCallback, useEffect, useRef, useState } from 'react';
import MapView from '../components/MapView';
import AutonomousPanel from '../components/dashboard/AutonomousPanel';
import { useRos } from '../context/RosContext';
import { useTelemetry } from '../context/TelemetryContext';
import { normalizeAngle, publishNavigationGoal } from '../utils/rosNavigation';

const NAV_BUSY_MS = 8000;

export default function AutonomousPage() {
  const { ros } = useRos();
  const { pose } = useTelemetry();
  const [draftGoal, setDraftGoal] = useState(null);
  const [lastSentGoal, setLastSentGoal] = useState(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [showBusyPopup, setShowBusyPopup] = useState(false);
  const [manualX, setManualX] = useState('');
  const [manualY, setManualY] = useState('');
  const [manualYaw, setManualYaw] = useState('');
  const manualFormInitialized = useRef(false);

  useEffect(() => {
    if (!pose || manualFormInitialized.current) return;
    manualFormInitialized.current = true;
    setManualX(pose.x.toFixed(2));
    setManualY(pose.y.toFixed(2));
    setManualYaw(((normalizeAngle(pose.yaw) * 180) / Math.PI).toFixed(1));
  }, [pose]);

  const sendNavigationGoal = useCallback((goal, sourceLabel) => {
    if (queueBusy) {
      setShowBusyPopup(true);
      return false;
    }

    const sent = publishNavigationGoal(ros, goal);
    if (!sent) return false;

    setDraftGoal(goal);
    setLastSentGoal({ ...goal, source: sourceLabel });
    setQueueBusy(true);
    window.setTimeout(() => setQueueBusy(false), NAV_BUSY_MS);
    return true;
  }, [queueBusy, ros]);

  const handleMapClick = (worldPos) => {
    console.log('HARITA TIKLAMA CALISTI', worldPos);
    const yaw = pose?.yaw != null ? normalizeAngle(pose.yaw) : 0;
    setManualX(worldPos.x.toFixed(2));
    setManualY(worldPos.y.toFixed(2));
    setManualYaw(((yaw * 180) / Math.PI).toFixed(1));
    sendNavigationGoal({ x: worldPos.x, y: worldPos.y, yaw }, 'Harita tıklama');
  };

  return (
    <div className="main-content">
      <div className="map-column map-column--no-joystick">
        <div className="map-panel">
          <MapView
            enableClickToGo
            onMapGoalClick={handleMapClick}
            goalMarker={draftGoal}
          />
        </div>
      </div>

      <AutonomousPanel
        draftGoal={draftGoal}
        onSendGoal={sendNavigationGoal}
        lastSentGoal={lastSentGoal}
        queueBusy={queueBusy}
        showBusyPopup={showBusyPopup}
        onCloseBusyPopup={() => setShowBusyPopup(false)}
        manualX={manualX}
        manualY={manualY}
        manualYaw={manualYaw}
        onManualXChange={setManualX}
        onManualYChange={setManualY}
        onManualYawChange={setManualYaw}
      />
    </div>
  );
}
