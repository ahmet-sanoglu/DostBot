import React, { useEffect, useRef, useState } from 'react';
import nipplejs from 'nipplejs';
import { Topic } from 'roslib';
import { useRos } from '../context/RosContext';
import { useTelemetry } from '../context/TelemetryContext';
import { CMD_VEL_JOY_TOPIC } from '../utils/rosTopics';

const JOYSTICK_SIZE = 100;
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
  const [isActive, setIsActive] = useState(false);
  const [displaySpeed, setDisplaySpeed] = useState({ linear: 0, angular: 0 });

  const velocityRef = useRef({ linearX: 0, angularZ: 0 });

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

    const handleEnd = () => {
      // Deadman: parmak bırakılınca hız sıfırlanır — robot kendi başına hareket etmesin diye.
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

  useEffect(() => {
    if (!ros) return;

    // PS4 kolu ile aynı kanal; robot tarafında twist_mux bu topic'i birleştirir.
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
      cmdVelTopic.publish({
        linear: { x: 0, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: 0 },
      });
      cmdVelTopic.unadvertise();
    };
  }, [ros, setVelocity]);

  return (
    <div className="manual-drive-controls">
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
