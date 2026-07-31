// Üst şerit: logo, sayfa başlığı, ROS bağlantı göstergesi, demo batarya ve Acil Dur butonu.
// Tüm sayfalarda (Kontrol + Mühendis) ortak görünür.

import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Topic } from 'roslib';
import { useNavigation } from '../../context/NavigationContext';
import { useRos } from '../../context/RosContext';
import { CMD_VEL_JOY_TOPIC } from '../../utils/rosTopics';
import logo from '../../assets/dost-tarim-logo.png';
const DEMO_BATTERY_PERCENT = 87;
const ESTOP_COOLDOWN_MS = 1000;

/**
 * Acil Dur: hem aktif Nav2 görevini iptal eder (emergencyStopNavigation)
 * hem joystick/manuel hızı sıfırlar (/cmd_vel/joy'a 0 Twist gönderir).
 * 1 sn debounce — çift tıklamada iki iptal/publish üst üste binmesin.
 */
function EmergencyStopButton() {
  const { ros } = useRos();
  const { emergencyStopNavigation } = useNavigation();
  const [locked, setLocked] = useState(false);
  const cooldownTimerRef = useRef(null);

  useEffect(() => () => {
    if (cooldownTimerRef.current) {
      window.clearTimeout(cooldownTimerRef.current);
    }
  }, []);

  const handleEmergencyStop = () => {
    if (locked) return;

    setLocked(true);
    cooldownTimerRef.current = window.setTimeout(() => {
      setLocked(false);
      cooldownTimerRef.current = null;
    }, ESTOP_COOLDOWN_MS);

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
    <button
      type="button"
      className={`estop-btn${locked ? ' estop-btn--cooldown' : ''}`}
      onClick={handleEmergencyStop}
      disabled={locked}
    >
      ACİL DUR
    </button>
  );
}

/** Demo batarya göstergesi — gerçek ROS batarya topic'i henüz bağlı değil. */
function TopBarBattery() {
  return (
    <div className="top-bar__battery" aria-label={`Batarya ${DEMO_BATTERY_PERCENT}%`}>
      <span className="top-bar__battery-icon" aria-hidden="true">🔋</span>
      <span className="top-bar__battery-percent">{DEMO_BATTERY_PERCENT}%</span>
    </div>
  );
}

/** Üst navigasyon çubuğu — marka, bağlantı durumu ve acil dur. */
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
