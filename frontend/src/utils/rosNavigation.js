import { ActionClient, Goal, Topic } from 'roslib';

export const GOAL_POSE_TOPIC = '/goal_pose';
export const NAV_ACTION_SERVER = '/navigate_to_pose';
export const NAV_ACTION_TYPE = 'nav2_msgs/action/NavigateToPose';

/** action_msgs/GoalStatus STATUS_CANCELED */
const GOAL_STATUS_CANCELED = 6;

let navigateActionClient = null;
// Acil Dur iptali için son gönderilen Nav2 goal referansı — modül düzeyinde tutulur.
let activeNavGoal = null;
let cancelRequestedByEstop = false;

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

function isCanceledActionResult(result) {
  if (!result) return false;

  const status = result.status
    ?? result?.status?.status
    ?? result?.goal_status?.status;

  if (status === GOAL_STATUS_CANCELED || status === 'STATUS_CANCELED') {
    return true;
  }

  return JSON.stringify(result).toLowerCase().includes('cancel');
}

function getOrCreateNavigateActionClient(ros) {
  if (!navigateActionClient || navigateActionClient.ros !== ros) {
    navigateActionClient = new ActionClient({
      ros,
      serverName: NAV_ACTION_SERVER,
      actionName: NAV_ACTION_TYPE,
    });
  }
  return navigateActionClient;
}

export function getActiveNavGoal() {
  return activeNavGoal;
}

// TopBar "Acil Dur" burayı çağırır; aktif Nav2 goal varsa goal.cancel() ile iptal eder.
export function cancelActiveNavigationGoal() {
  const goal = activeNavGoal;
  if (!goal) {
    return false;
  }

  cancelRequestedByEstop = true;
  console.log('[acilDur] Aktif Nav2 görevi iptal edildi');
  goal.cancel();
  return true;
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

// Nav2 action birincil yol; /goal_pose ise RViz ve eski dinleyicilerle uyumluluk için paralel gönderilir.
export function publishNavigationGoal(ros, { x, y, yaw, frameId = 'map' }) {
  console.log('[sendNavigationGoal] başlatılıyor', { x, y, yaw, frameId });

  if (!ros) {
    console.warn('[sendNavigationGoal] ROS bağlantısı yok — gönderim iptal');
    return false;
  }

  try {
    const actionClient = getOrCreateNavigateActionClient(ros);

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

    activeNavGoal = goal;

    goal.on('feedback', (feedback) => {
      console.log('[sendNavigationGoal] action feedback', feedback);
    });

    goal.on('result', (result) => {
      console.log('[sendNavigationGoal] action result', result);

      if (cancelRequestedByEstop) {
        console.log('[acilDur] goal.on(\'result\') callback tetiklendi', result);
        if (isCanceledActionResult(result)) {
          console.log('[acilDur] goal.on(\'result\') CANCELED durumuyla tetiklendi', result);
        }
        cancelRequestedByEstop = false;
      }

      if (activeNavGoal === goal) {
        activeNavGoal = null;
      }
    });

    goal.on('status', (status) => {
      console.log('[sendNavigationGoal] action status', status);
    });

    goal.on('timeout', () => {
      console.warn('[sendNavigationGoal] action timeout');
      if (activeNavGoal === goal) {
        activeNavGoal = null;
      }
    });

    console.log('[sendNavigationGoal] Nav2 action gönderiliyor', NAV_ACTION_SERVER);
    goal.send();
  } catch (error) {
    console.error('[sendNavigationGoal] action client hatası', error);
    activeNavGoal = null;
  }

  publishGoalPoseTopic(ros, { x, y, yaw, frameId });
  return true;
}
