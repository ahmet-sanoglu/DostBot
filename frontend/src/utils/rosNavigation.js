import { ActionClient, Goal, Topic } from 'roslib';

export const GOAL_POSE_TOPIC = '/goal_pose';
export const NAV_ACTION_SERVER = '/navigate_to_pose';
export const NAV_ACTION_TYPE = 'nav2_msgs/action/NavigateToPose';

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

function publishGoalPoseTopic(ros, { x, y, yaw, frameId = 'map' }) {
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
  console.log('[sendNavigationGoal] /goal_pose topic publish tamamlandı');
}

export function publishNavigationGoal(ros, { x, y, yaw, frameId = 'map' }) {
  console.log('[sendNavigationGoal] başlatılıyor', { x, y, yaw, frameId });

  if (!ros) {
    console.warn('[sendNavigationGoal] ROS bağlantısı yok — gönderim iptal');
    return false;
  }

  try {
    const actionClient = new ActionClient({
      ros,
      serverName: NAV_ACTION_SERVER,
      actionName: NAV_ACTION_TYPE,
    });

    const goal = new Goal({
      actionClient,
      goalMessage: {
        pose: {
          header: {
            frame_id: frameId,
            stamp: { sec: 0, nanosec: 0 },
          },
          pose: {
            position: { x, y, z: 0 },
            orientation: yawToQuaternion(yaw),
          },
        },
      },
    });

    goal.on('feedback', (feedback) => {
      console.log('[sendNavigationGoal] action feedback', feedback);
    });

    goal.on('result', (result) => {
      console.log('[sendNavigationGoal] action result', result);
    });

    goal.on('status', (status) => {
      console.log('[sendNavigationGoal] action status', status);
    });

    goal.on('timeout', () => {
      console.warn('[sendNavigationGoal] action timeout');
    });

    console.log('[sendNavigationGoal] Nav2 action gönderiliyor', NAV_ACTION_SERVER);
    goal.send();
  } catch (error) {
    console.error('[sendNavigationGoal] action client hatası', error);
  }

  publishGoalPoseTopic(ros, { x, y, yaw, frameId });
  return true;
}
