import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Topic } from 'roslib';
import { useNavigation } from '../../context/NavigationContext';
import { useRos } from '../../context/RosContext';
import { CMD_VEL_JOY_TOPIC } from '../../utils/rosTopics';
import logo from '../../assets/dost-tarim-logo.png';
const DEMO_BATTERY_PERCENT = 87;

function EmergencyStopButton() {
  const { ros } = useRos();
  const { emergencyStopNavigation } = useNavigation();

  const handleEmergencyStop = () => {
    emergencyStopNavigation();

    if (!ros) return;

    const cmdVelTopic = new Topic({
      ros,
      name: CMD_VEL_JOY_TOPIC,
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
    </div>
  );
}

export default function TopBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { status } = useRos();
  const isConnected = status === 'ROS bağlantısı kuruldu';
  const pageTitle = pathname.startsWith('/muhendis')
    ? 'Mühendis Paneli'
    : 'Kontrol Paneli';

  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        <img
          src={logo}
          alt="Dost Tarım Teknolojileri"
          className="top-bar__brand-logo"
          onClick={() => navigate('/')}
        />
        <div className="top-bar__brand-divider" aria-hidden="true" />
        <span className="top-bar__brand-title">{pageTitle}</span>
      </div>

      <div className="top-bar__actions-card">
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
