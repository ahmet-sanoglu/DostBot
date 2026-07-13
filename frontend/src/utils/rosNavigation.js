import { Topic } from 'roslib';

export const GOAL_POSE_TOPIC = '/goal_pose';

export function normalizeAngle(angle) {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function yawToQuaternion(yaw) {
  const half = normalizeAngle(yaw) / 2;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

export function degreesToRadians(deg) {
  return (deg * Math.PI) / 180;
}

export function publishNavigationGoal(ros, { x, y, yaw, frameId = 'map' }) {
  if (!ros) return false;

  const goalTopic = new Topic({
    ros,
    name: GOAL_POSE_TOPIC,
    messageType: 'geometry_msgs/PoseStamped',
  });

  goalTopic.advertise();
  goalTopic.publish({
    header: {
      frame_id: frameId,
      stamp: { secs: 0, nsecs: 0 },
    },
    pose: {
      position: { x, y, z: 0 },
      orientation: yawToQuaternion(yaw),
    },
  });
  goalTopic.unadvertise();
  return true;
}
