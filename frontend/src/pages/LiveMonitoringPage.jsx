import React from 'react';
import MapView from '../components/MapView';
import Joystick from '../components/Joystick';
import TelemetryPanel from '../components/dashboard/TelemetryPanel';

export default function LiveMonitoringPage() {
  return (
    <div className="main-content">
      <div className="map-column">
        <div className="map-panel">
          <MapView />
        </div>

        <div className="joystick-dock">
          <Joystick />
        </div>
      </div>

      <TelemetryPanel />
    </div>
  );
}
