// Robot navigasyon hedeflerini ROS'a gönderir ve iptal eder.
// rosbridge ROS 2 action feedback/result/cancel'ı güvenilir taşımadığı için durum takibi
// /navigate_to_pose/_action/status topic'i ve iptal /_action/cancel_goal servisi ile yapılır.
// ActionClient + Goal hâlâ hedef göndermek (ve yedek iptal) için kullanılır; /goal_pose topic yedek/uyumluluk içindir.

import { ActionClient, Goal, Service, Topic } from 'roslib';

export const GOAL_POSE_TOPIC = '/goal_pose';
export const NAV_ACTION_SERVER = '/navigate_to_pose';
export const NAV_ACTION_TYPE = 'nav2_msgs/action/NavigateToPose';
export const NAV_STATUS_TOPIC = '/navigate_to_pose/_action/status';
export const NAV_STATUS_TYPE = 'action_msgs/msg/GoalStatusArray';
export const NAV_CANCEL_SERVICE = '/navigate_to_pose/_action/cancel_goal';
export const NAV_CANCEL_SERVICE_TYPE = 'action_msgs/srv/CancelGoal';

/** action_msgs/GoalStatus — terminal durumlar meşguliyeti kapatır */
export const GOAL_STATUS = {
  ACCEPTED: 1,
  EXECUTING: 2,
  SUCCEEDED: 4,
  CANCELED: 5,
  ABORTED: 6,
};

const TERMINAL_STATUSES = new Set([
  GOAL_STATUS.SUCCEEDED,
  GOAL_STATUS.CANCELED,
  GOAL_STATUS.ABORTED,
]);

// ActionClient: ROS "action" protokolü için kalıcı istemci; her hedefte yeniden oluşturulmaz.
let navigateActionClient = null;
// Acil Dur iptali için son gönderilen Nav2 goal referansı — modül düzeyinde tutulur.
let activeNavGoal = null;
let cancelRequestedByEstop = false;
let statusTopic = null;
let statusTopicRos = null;

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

  if (status === GOAL_STATUS.CANCELED || status === 'STATUS_CANCELED') {
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

/**
 * Nav2 action durum topic'ini dinler.
 * status_list'in son elemanı güncel görev kabul edilir (Goal ID / stamp eşleştirmesi yok).
 * Terminal status (4/5/6) NavigationContext'e iletilir; meşguliyet queueBusy ile yönetilir.
 * Dönüş: abone olmayı kaldıran cleanup fonksiyonu.
 */
export function subscribeNavigationStatus(ros, onStatus) {
  if (!ros || typeof onStatus !== 'function') {
    return () => {};
  }

  if (statusTopic && statusTopicRos === ros) {
    statusTopic.unsubscribe();
  }

  statusTopic = new Topic({
    ros,
    name: NAV_STATUS_TOPIC,
    messageType: NAV_STATUS_TYPE,
  });
  statusTopicRos = ros;

  statusTopic.subscribe((message) => {
    const list = message.status_list;
    if (!Array.isArray(list) || list.length === 0) return;

    // ID eşleştirme yok — dizideki son eleman güncel görev sayılır
    const latest = list[list.length - 1];
    const status = latest.status;
    console.log('[navStatus] status:', status);

    onStatus({
      status,
      succeeded: status === GOAL_STATUS.SUCCEEDED,
      canceled: status === GOAL_STATUS.CANCELED,
      aborted: status === GOAL_STATUS.ABORTED,
      terminal: TERMINAL_STATUSES.has(status),
    });
  });

  return () => {
    if (statusTopic) {
      statusTopic.unsubscribe();
      statusTopic = null;
      statusTopicRos = null;
    }
  };
}

/**
 * TopBar "Acil Dur" burayı çağırır.
 * 1) Varsa aktif Goal üzerinde goal.cancel() (rosbridge action yolu — yedek)
 * 2) /navigate_to_pose/_action/cancel_goal servisi (birincil; boş goal_id = tüm aktif görevler)
 */
export function cancelActiveNavigationGoal(ros) {
  cancelRequestedByEstop = true;

  const goal = activeNavGoal;
  if (goal) {
    console.log('[acilDur] Aktif Nav2 görevi iptal edildi (goal.cancel)');
    goal.cancel();
  }

  if (ros) {
    const cancelService = new Service({
      ros,
      name: NAV_CANCEL_SERVICE,
      serviceType: NAV_CANCEL_SERVICE_TYPE,
    });
    // Boş goal_id = tüm aktif NavigateToPose görevlerini iptal et (ROS 2 CancelGoal standardı)
    const request = {
      goal_info: {
        goal_id: { uuid: [] },
        stamp: { sec: 0, nanosec: 0 },
      },
    };
    cancelService.callService(request, (response) => {
      console.log('[acilDur] cancel_goal servis cevabı:', response);
    }, (error) => {
      console.error('[acilDur] cancel_goal servis hatası:', error);
    });
  }

  return Boolean(goal || ros);
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
 * 1) Nav2 action (birincil): hedef gönderimi; feedback/result rosbridge'te güvenilir olmayabilir.
 * 2) /goal_pose topic (paralel): RViz, eski scriptler veya action dinlemeyen araçlar için uyumluluk.
 * Durum takibi subscribeNavigationStatus ile /_action/status üzerinden yapılır.
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
