// Robot navigasyon hedeflerini ROS'a gönderir ve iptal eder.
// Nav2 "action" (hedef + geri bildirim + iptal) birincil yol; /goal_pose topic'i yedek/uyumluluk içindir.
// Acil Dur butonu aktif hedefi goal.cancel() ile iptal etmek için activeNavGoal referansını tutar.

import { ActionClient, Goal, Topic } from 'roslib';

export const GOAL_POSE_TOPIC = '/goal_pose';
export const NAV_ACTION_SERVER = '/navigate_to_pose';
export const NAV_ACTION_TYPE = 'nav2_msgs/action/NavigateToPose';

/** ROS action iptal sonucu: action_msgs/GoalStatus STATUS_CANCELED = 6 */
const GOAL_STATUS_CANCELED = 6;

// ActionClient: ROS "action" protokolü için kalıcı istemci; her hedefte yeniden oluşturulmaz.
let navigateActionClient = null;
// Acil Dur iptali için son gönderilen Nav2 goal referansı — modül düzeyinde tutulur.
let activeNavGoal = null;
let cancelRequestedByEstop = false;

/** Açıyı -π ile +π arasına sıkıştırır; robot yön hesaplarında taşmayı önler. */
export function normalizeAngle(angle) {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Yaw açısını (radyan, düzlemde dönüş) ROS quaternion formatına çevirir.
 * Quaternion: robot yönelimini x,y,z,w dörtlüsüyle ifade eder; Nav2 hedef mesajında zorunludur.
 */
export function yawToQuaternion(yaw) {
  const half = normalizeAngle(yaw) / 2;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

/** Mühendis panelinde derece girilir; ROS metre/radyan kullanır — dönüşüm burada yapılır. */
export function degreesToRadians(deg) {
  return (deg * Math.PI) / 180;
}

/** Action result mesajının iptal (CANCELED) durumuyla gelip gelmediğini kontrol eder. */
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

/** Aynı ros bağlantısı için tek ActionClient kullanır; gereksiz yeniden bağlantı önlenir. */
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

/** Dışarıdan aktif Nav2 hedefinin okunması (debug/test amaçlı). */
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

/**
 * /goal_pose topic'ine tek seferlik PoseStamped yayınlar.
 * Topic: ROS'ta tek yönlü mesaj kanalı (action'dan farklı olarak geri bildirim/iptal yok).
 */
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

/**
 * Navigasyon hedefini robota gönderir.
 * 1) Nav2 action (birincil): geri bildirim, sonuç ve iptal destekler.
 * 2) /goal_pose topic (paralel): RViz, eski scriptler veya action dinlemeyen araçlar için uyumluluk.
 * İkisi de aynı koordinatları taşır; asıl navigasyon Nav2 action üzerinden yürür.
 */
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
