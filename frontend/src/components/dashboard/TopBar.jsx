import React from 'react';
import { Topic } from 'roslib';
import { useRos } from '../../context/RosContext';

const CMD_VEL_TOPIC = '/cmd_vel';
const DEMO_BATTERY_PERCENT = 87;

function EmergencyStopButton() {
  const { ros } = useRos();

  const handleEmergencyStop = () => {
    if (!ros) return;

    const cmdVelTopic = new Topic({
      ros,
      name: CMD_VEL_TOPIC,
      messageType: 'geometry_msgs/Twist',
    });

    cmdVelTopic.advertise();
    cmdVelTopic.publish({
      linear: { x: 0, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
    });
    cmdVelTopic.unadvertise();
  };

  return (
    <button type="button" className="estop-btn" onClick={handleEmergencyStop}>
      ACİL DUR
    </button>
  );
}

function TopBarBattery() {
  return (
    <div className="top-bar__battery" aria-label={`Batarya ${DEMO_BATTERY_PERCENT}%`}>
      <span className="top-bar__battery-icon" aria-hidden="true">🔋</span>
      <span className="top-bar__battery-percent">{DEMO_BATTERY_PERCENT}%</span>
      <div className="top-bar__battery-bar">
        <div
          className="top-bar__battery-fill"
          style={{ width: `${DEMO_BATTERY_PERCENT}%` }}
        />
      </div>
    </div>
  );
}

export default function TopBar() {
  const { status } = useRos();
  const isConnected = status === 'ROS bağlantısı kuruldu';

  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        <span className="top-bar__brand-icon">🌾</span>
        <span>AgriFleet</span>
      </div>

      <div className="top-bar__actions">
        <div className="top-bar__status">
          <span
            className={`status-dot ${isConnected ? 'status-dot--connected' : 'status-dot--disconnected'}`}
          />
          <span>{isConnected ? 'Bağlı' : 'Bağlantı Yok'}</span>
        </div>

        <TopBarBattery />
        <EmergencyStopButton />
      </div>
    </header>
  );
}
