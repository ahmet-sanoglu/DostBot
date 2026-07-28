// Robot navigasyon hedeflerini nav_relay.py üzerinden gönderir / iptal eder / dinler.
// Eski yaklaşım (web tarafında ActionClient/Goal + /goal_pose yedeği) kaldırıldı; çünkü rosbridge
// ROS 2 action feedback/result/cancel akışını güvenilir taşımıyor ve UI tarafında tahmine dayalı
// status yorumları gerekiyordu. Düz topic + native röle ile web tarafı sade, deterministik kalır.

import { Topic } from 'roslib';

export const NAV_COMMAND_TOPIC = '/agrifleet/nav_command';
export const NAV_STATUS_TOPIC = '/agrifleet/nav_status';

/** Açıyı -π ile +π arasına sıkıştırır; robot yön hesaplarında taşmayı önler. */
export function normalizeAngle(angle) {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Yaw açısını (radyan, düzlemde dönüş) ROS quaternion formatına çevirir.
 * Quaternion: robot yönelimini x,y,z,w dörtlüsüyle ifade eder.
 */
export function yawToQuaternion(yaw) {
  const half = normalizeAngle(yaw) / 2;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

/** Mühendis panelinde derece girilir; ROS metre/radyan kullanır — dönüşüm burada yapılır. */
export function degreesToRadians(deg) {
  return (deg * Math.PI) / 180;
}

function publishNavCommand(ros, payload) {
  // Tek komut kanalı: hedef gönderme ve iptal aynı topic üstünden JSON ile taşınır; frontend
  // ActionClient yaşam döngüsü yönetmez, bunu native röleye bırakır.
  const commandTopic = new Topic({
    ros,
    name: NAV_COMMAND_TOPIC,
    messageType: 'std_msgs/String',
  });
  commandTopic.publish({ data: JSON.stringify(payload) });
}

/**
 * Navigasyon hedefini röleye gönderir → röle Nav2 NavigateToPose action'ına iletir.
 * Sonuç /agrifleet/nav_status üzerinden gelir (accepted / feedback / result / rejected).
 */
export function publishNavigationGoal(ros, { x, y, yaw }) {
  if (!ros) {
    console.warn('[sendNavigationGoal] ROS bağlantısı yok — gönderim iptal');
    return false;
  }

  console.log('[sendNavigationGoal] nav_command', { x, y, yaw });
  publishNavCommand(ros, { x, y, yaw });
  return true;
}

/** Acil Dur — röleye cancel; röle aktif goal handle üzerinde cancel_goal_async çağırır. */
export function cancelActiveNavigationGoal(ros) {
  if (!ros) return false;

  console.log('[acilDur] nav_command cancel');
  publishNavCommand(ros, { type: 'cancel' });
  return true;
}

/**
 * Röle durum topic'ini dinler. Mesaj gövdesi JSON: {type, status?, distance_remaining?}.
 * Dönüş: abone olmayı kaldıran cleanup. Ayrı status_list/goal_id takibi gerekmez; röle tek
 * güvenilir accepted/feedback/result/rejected akışını zaten sadeleştirerek yayınlar.
 */
export function subscribeNavigationStatus(ros, onStatus) {
  if (!ros || typeof onStatus !== 'function') {
    return () => {};
  }

  const statusTopic = new Topic({
    ros,
    name: NAV_STATUS_TOPIC,
    messageType: 'std_msgs/String',
  });

  const handler = (msg) => {
    try {
      onStatus(JSON.parse(msg.data));
    } catch (error) {
      console.error('[navStatus] parse hatasi', error);
    }
  };

  statusTopic.subscribe(handler);
  return () => statusTopic.unsubscribe(handler);
}
