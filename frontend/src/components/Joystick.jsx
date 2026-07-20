// Operatör panelindeki sanal joystick — parmak/mouse ile manuel robot sürüşü.
// Hız komutlarını /cmd_vel/joy ROS topic'ine gönderir (PS4 kolu ile aynı kanal).
// Bırakınca sıfır hız (deadman) gönderilir; robot kendi başına hareket etmesin diye.

import React, { useEffect, useRef, useState } from 'react';
import nipplejs from 'nipplejs';
import { Topic } from 'roslib';
import { useRos } from '../context/RosContext';
import { useTelemetry } from '../context/TelemetryContext';
import { CMD_VEL_JOY_TOPIC } from '../utils/rosTopics';

const JOYSTICK_SIZE = 100;
const MAX_LINEAR = 0.5;   // m/s
const MAX_ANGULAR = 1.0;  // rad/s
const PUBLISH_INTERVAL_MS = 100; // 10 Hz — saniyede 10 kez hız komutu gönderilir

/** Değeri [min, max] aralığına sıkıştırır. */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * nipplejs move verisinden linear.x (ileri/geri) ve angular.z (dönüş) hesaplar.
 * nipplejs açısı sağdan (0 rad) başlar; ekranda ileri = yukarı olması için π/2 kaydırılır.
 */
function velocitiesFromJoystick(data) {
  const force = Math.min(data.force, 1);
  const angle = data.angle.radian - Math.PI / 2;

  const linearX = clamp(force * Math.cos(angle) * MAX_LINEAR, -MAX_LINEAR, MAX_LINEAR);
  const angularZ = clamp(force * Math.sin(angle) * MAX_ANGULAR, -MAX_ANGULAR, MAX_ANGULAR);

  return { linearX, angularZ };
}

/** Sanal joystick bileşeni — nipplejs kütüphanesi dokunmatik/sürükleme hareketini yönetir. */
const Joystick = () => {
  const zoneRef = useRef(null);
  const { ros } = useRos();
  const { setVelocity } = useTelemetry();
  const [isActive, setIsActive] = useState(false);
  const [displaySpeed, setDisplaySpeed] = useState({ linear: 0, angular: 0 });

  // useRef: hız değerini render tetiklemeden saklar; 10 Hz interval bu ref'i okuyarak ROS'a yazar.
  const velocityRef = useRef({ linearX: 0, angularZ: 0 });

  // nipplejs joystick UI'sini zoneRef elemanına bağlar (mount/unmount yaşam döngüsü).
  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;

    const manager = nipplejs.create({
      zone,
      mode: 'static',
      position: { left: '50%', top: '50%' },
      color: 'rgba(6, 168, 155, 0.15)',
      size: JOYSTICK_SIZE,
      dynamicPage: true,
    });

    const handleStart = () => {
      setIsActive(true);
    };

    const handleMove = (evt) => {
      const { linearX, angularZ } = velocitiesFromJoystick(evt.data);
      velocityRef.current = { linearX, angularZ };
      setDisplaySpeed({ linear: linearX, angular: angularZ });
    };

    // Deadman güvenlik: parmak/joystick bırakılınca hız sıfırlanır — robot kendi başına gitmesin.
    const handleEnd = () => {
      velocityRef.current = { linearX: 0, angularZ: 0 };
      setIsActive(false);
      setDisplaySpeed({ linear: 0, angular: 0 });
    };

    manager.on('start', handleStart);
    manager.on('move', handleMove);
    manager.on('end', handleEnd);

    return () => {
      manager.destroy();
      velocityRef.current = { linearX: 0, angularZ: 0 };
      setIsActive(false);
      setDisplaySpeed({ linear: 0, angular: 0 });
    };
  }, []);

  // ROS Topic: /cmd_vel/joy — "joy" PS4 gamepad ile aynı kanal adı; robot twist_mux ikisini birleştirir.
  useEffect(() => {
    if (!ros) return;

    const cmdVelTopic = new Topic({
      ros,
      name: CMD_VEL_JOY_TOPIC,
      messageType: 'geometry_msgs/Twist',
    });

    cmdVelTopic.advertise();

    const publishTwist = () => {
      const { linearX, angularZ } = velocityRef.current;
      setVelocity({ linearX, angularZ });
      cmdVelTopic.publish({
        linear: { x: linearX, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: angularZ },
      });
    };

    const intervalId = setInterval(publishTwist, PUBLISH_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      cmdVelTopic.publish({  // bileşen kapanırken de sıfır hız — güvenlik
        linear: { x: 0, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: 0 },
      });
      cmdVelTopic.unadvertise();
    };
  }, [ros, setVelocity]);

  return (
    <div className="manual-drive-controls">
      {/*
        .joystick-zone CSS'te position: relative olmalı — nipplejs iç elemanları absolute konumlar;
        relative olmayan ata eleman varsa knob ekranda kayar (DevTools ile tespit edildi).
      */}
      <div
        ref={zoneRef}
        className={`joystick-zone${isActive ? ' active' : ''}`}
      />
      <p className="manual-drive__hint">Sürükleyerek yönlendirin</p>
      <p className="manual-drive__velocity" aria-live="polite">
        {isActive
          ? `${displaySpeed.linear.toFixed(2)} m/s · ${displaySpeed.angular.toFixed(2)} rad/s`
          : 'Duruyor'}
      </p>
    </div>
  );
};

export default Joystick;
