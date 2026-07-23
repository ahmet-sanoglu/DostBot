// "Toprağı Sür" step action'ının ROS entegrasyonu — NavigationContext her adıma varınca till ise burayı çağırır.
// Nav2 NavigateToPose'dan farklıdır; coverage alanı robot tarafında önceden hazırlanır (servis + action).

import { Service, ActionClient, Goal } from 'roslib';

const START_COVERAGE_SERVICE = '/start_coverage';
const START_COVERAGE_SERVICE_TYPE = 'dost_tarim/srv/StartCoverage';
const COVERAGE_ACTION_SERVER = '/navigate_to_pose';  // aynı Nav2 BT Navigator sunucusu
const COVERAGE_ACTION_TYPE = 'opennav_coverage_msgs/action/NavigateCompleteCoverage';

// opennav_coverage_msgs kendi hata aralığını kullanır (800'ler) — nav2_msgs (4/6/9000) tablosu burada geçersiz
const COVERAGE_ERROR_NONE = 0;
const COVERAGE_ERROR_MESSAGES = {
  0: 'Başarılı',
  800: 'Bilinmeyen hata',
  801: 'Davranış ağacı yüklenemedi',
  802: 'TF hatası',
};

let coverageActionClient = null;

function getOrCreateCoverageActionClient(ros) {
  if (!coverageActionClient || coverageActionClient.ros !== ros) {
    coverageActionClient = new ActionClient({
      ros,
      serverName: COVERAGE_ACTION_SERVER,
      actionName: COVERAGE_ACTION_TYPE,
    });
  }
  return coverageActionClient;
}

/**
 * Akış: /start_coverage servisi alanı hazırlar → kabul edilirse NavigateCompleteCoverage action başlar.
 * Servis reddederse action gönderilmez — robot tarafı hazır olmadan coverage başlatılmaz.
 */
export function startCoverageTask(ros, { onFeedback, onResult } = {}) {
  if (!ros) {
    onResult?.(false, 'ROS bağlantısı yok');
    return;
  }

  const service = new Service({
    ros,
    name: START_COVERAGE_SERVICE,
    serviceType: START_COVERAGE_SERVICE_TYPE,
  });

  const request = { loop_count: 1 };

  console.log('[toprakSur] start_coverage servisi çağrılıyor', request);

  service.callService(request, (response) => {
    console.log('[toprakSur] start_coverage cevabı', response);

    if (!response.success) {
      onResult?.(false, response.message || 'Servis görevi reddetti');
      return;
    }

    const actionClient = getOrCreateCoverageActionClient(ros);
    const goal = new Goal({
      actionClient,
      goalMessage: {
        field_filepath: '',
        polygons: [],
        frame_id: 'map',
        behavior_tree: '',
      },
    });

    goal.on('feedback', (feedback) => {
      console.log('[toprakSur] action feedback', feedback);
      const estimatedSeconds = feedback.estimated_time_remaining
        ? feedback.estimated_time_remaining.sec
        : null;
      onFeedback?.(feedback.distance_remaining, estimatedSeconds);
    });

    goal.on('result', (result) => {
      console.log('[toprakSur] action result', result);
      const success = result.error_code === COVERAGE_ERROR_NONE;
      const message = success
        ? 'Toprak sürme tamamlandı'
        : (COVERAGE_ERROR_MESSAGES[result.error_code] || result.error_msg || 'Bilinmeyen hata');
      onResult?.(success, message);
    });

    console.log('[toprakSur] NavigateCompleteCoverage action gönderiliyor');
    goal.send();
  }, (error) => {
    console.error('[toprakSur] start_coverage servis hatası', error);
    onResult?.(false, 'Servise ulaşılamadı');
  });
}
