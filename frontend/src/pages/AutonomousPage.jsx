import React, { useCallback, useState } from 'react';
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

  const handleMapClick = ({ x, y }) => {
    const yaw = pose?.yaw != null ? normalizeAngle(pose.yaw) : 0;
    sendNavigationGoal({ x, y, yaw }, 'Harita tıklama');
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
      />
    </div>
  );
}
