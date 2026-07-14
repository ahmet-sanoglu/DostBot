import React, { useEffect, useRef } from 'react';
import nipplejs from 'nipplejs';
import { Topic } from 'roslib';
import { useRos } from '../context/RosContext';
import { useTelemetry } from '../context/TelemetryContext';

const CMD_VEL_TOPIC = '/cmd_vel';
const MAX_LINEAR = 0.5;   // m/s
const MAX_ANGULAR = 1.0;  // rad/s
const PUBLISH_INTERVAL_MS = 100; // 10 Hz

/** Değeri [min, max] aralığına sıkıştırır */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * nipplejs move verisinden linear.x ve angular.z hesaplar.
 * Formül: linear = force·cos(angle), angular = force·sin(angle)
 * nipplejs açısı sağdan (0 rad) başlar; ileri = yukarı olması için π/2 kaydırılır.
 */
function velocitiesFromJoystick(data) {
  const force = Math.min(data.force, 1);
  const angle = data.angle.radian - Math.PI / 2;

  const linearX = clamp(force * Math.cos(angle) * MAX_LINEAR, -MAX_LINEAR, MAX_LINEAR);
  const angularZ = clamp(force * Math.sin(angle) * MAX_ANGULAR, -MAX_ANGULAR, MAX_ANGULAR);

  return { linearX, angularZ };
}

const Joystick = () => {
  const zoneRef = useRef(null);
  const { ros } = useRos();
  const { setVelocity } = useTelemetry();

  // Güncel hız komutları — interval callback'i ref üzerinden okur
  const velocityRef = useRef({ linearX: 0, angularZ: 0 });

  // ── nipplejs: ekranın alt-ortasında sabit dairesel joystick ──
  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;

    const manager = nipplejs.create({
      zone,
      mode: 'static',
      position: { left: '50%', top: '50%' },
      color: 'rgba(6, 168, 155, 0.75)',
      size: 90,
      dynamicPage: true,
    });

    const handleMove = (evt) => {
      velocityRef.current = velocitiesFromJoystick(evt.data);
    };

    const handleEnd = () => {
      // Joystick bırakılınca robotu durdur
      velocityRef.current = { linearX: 0, angularZ: 0 };
    };

    manager.on('move', handleMove);
    manager.on('end', handleEnd);

    return () => {
      manager.destroy();
      velocityRef.current = { linearX: 0, angularZ: 0 };
    };
  }, []);

  // ── /cmd_vel topic'ine 10 Hz geometry_msgs/Twist yayınla ──
  useEffect(() => {
    if (!ros) return;

    const cmdVelTopic = new Topic({
      ros,
      name: CMD_VEL_TOPIC,
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
      // Bileşen kaldırılırken robotu durdur
      cmdVelTopic.publish({
        linear: { x: 0, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: 0 },
      });
      cmdVelTopic.unadvertise();
    };
  }, [ros, setVelocity]);

  return (
    <div ref={zoneRef} className="joystick-zone" />
  );
};

export default Joystick;
