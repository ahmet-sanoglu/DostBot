// Operatör panelindeki navigasyon akışını yönetir: hedef gönderme, görev kuyruğu, durum metni.
// Nav2'ye tek seferde bir hedef gider; çok adımlı görevlerin kalan adımları sırayla bekletilir.
// Acil Dur, görev iptali ve "Son Olaylar" panelindeki mesajlar da buradan yönetilir.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ROS_CONNECTED_STATUS, useRos } from './RosContext';
import { cancelActiveNavigationGoal, publishNavigationGoal } from '../utils/rosNavigation';
import { startCoverageTask } from '../utils/coverageAction';

const NAV_BUSY_MS = 8000;  // Nav2 yanıt bekleme süresi; sonrasında queueBusy false olur
const MAX_EVENTS = 10;

const NavigationContext = createContext(null);

/** Son Olaylar panelinde gösterilecek saat damgasını Türkçe formatta üretir. */
function formatEventTime(date = new Date()) {
  return date.toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Durum kartında gösterilecek metni bağlantı, acil dur, coverage ve görev ilerlemesine göre üretir. */
export function getStatusText({ isConnected, emergencyStopped, coverageStatus, queueBusy, activeTaskProgress }) {
  if (!isConnected) {
    return '⚠️ Bağlantı Yok';
  }
  if (emergencyStopped) {
    return '⛔ Durduruldu';
  }
  if (coverageStatus) {
    return coverageStatus;
  }
  if (queueBusy && activeTaskProgress) {
    return `🎯 ${activeTaskProgress.taskName} - Adım ${activeTaskProgress.currentStep}/${activeTaskProgress.totalSteps}`;
  }
  if (queueBusy) {
    return '🎯 Hedefe gidiyor';
  }
  return '✅ Hazır';
}

/** Görev JSON'undaki adımları geçerli koordinatlarla filtreler; eksik alanları atlar. */
function normalizeTaskSteps(task) {
  if (!Array.isArray(task?.steps)) return [];
  return task.steps
    .filter((step) => typeof step?.x === 'number' && typeof step?.y === 'number')
    .map((step) => ({
      x: step.x,
      y: step.y,
      yaw: typeof step.yaw === 'number' ? step.yaw : 0,
    }));
}

export function NavigationProvider({ children }) {
  const { ros, status, clearPlanPath } = useRos();

  const [lastSentGoal, setLastSentGoal] = useState(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [showBusyPopup, setShowBusyPopup] = useState(false);
  const [recentEvents, setRecentEvents] = useState([]);
  const [activeTaskProgress, setActiveTaskProgress] = useState(null);
  const [emergencyStopped, setEmergencyStopped] = useState(false);
  const [coverageStatus, setCoverageStatus] = useState(null);

  // useRef: render'lar arasında değeri saklar; değişince ekranı yeniden çizmez (timer id'leri için ideal).
  const busyTimerRef = useRef(null);
  const estopResetTimerRef = useRef(null);
  const wasBusyRef = useRef(false);
  // estopTriggeredRef: Acil Dur sonrası queueBusy false olunca yanlışlıkla "görev tamamlandı"
  // event'i yazılmasını önler — aksi halde iptal edilmiş görev tamamlanmış gibi görünürdü.
  const estopTriggeredRef = useRef(false);
  // skipNextIdleEventRef: coverage gibi finalAction sonrası gereksiz "Görev tamamlandı" event'ini atlar.
  const skipNextIdleEventRef = useRef(false);
  const wasConnectedRef = useRef(status === ROS_CONNECTED_STATUS);
  const connectionInitializedRef = useRef(false);
  // pendingStepsRef: çok adımlı görevde henüz gönderilmemiş adımlar; UI'da gösterilmez, kuyrukta bekler.
  const pendingStepsRef = useRef([]);
  const activeTaskRef = useRef(null);

  const isConnected = status === ROS_CONNECTED_STATUS;

  /** Son Olaylar paneline en fazla MAX_EVENTS kayıt ekler; en yenisi üstte görünür. */
  const addEvent = useCallback((message) => {
    const entry = {
      id: crypto.randomUUID(),
      time: formatEventTime(),
      message,
    };
    setRecentEvents((prev) => [entry, ...prev].slice(0, MAX_EVENTS));
  }, []);

  /** Nav2'ye hedef gönderir, meşgul bayrağını açar ve NAV_BUSY_MS sonra otomatik kapatır. */
  const dispatchGoal = useCallback((goal, sourceLabel) => {
    const sent = publishNavigationGoal(ros, goal);
    if (!sent) return false;

    clearPlanPath();
    setLastSentGoal({ ...goal, source: sourceLabel });
    setQueueBusy(true);

    if (busyTimerRef.current) {
      window.clearTimeout(busyTimerRef.current);
    }
    busyTimerRef.current = window.setTimeout(() => {
      setQueueBusy(false);
      busyTimerRef.current = null;
    }, NAV_BUSY_MS);

    return true;
  }, [clearPlanPath, ros]);

  /** Tek hedef gönderir; robot meşgulse popup gösterir ve reddeder. */
  const sendNavigationGoal = useCallback((goal, sourceLabel) => {
    if (queueBusy || pendingStepsRef.current.length > 0) {
      setShowBusyPopup(true);
      return false;
    }

    activeTaskRef.current = null;
    setActiveTaskProgress(null);
    pendingStepsRef.current = [];

    const sent = dispatchGoal(goal, sourceLabel);
    if (sent) {
      addEvent(sourceLabel || 'Hedefe gidiliyor');
    }
    return sent;
  }, [addEvent, dispatchGoal, queueBusy]);

  // Acil Dur (TopBar): Nav2 goal iptali + kuyruk/timer temizliği; joystick sıfırlama TopBar'da ayrı yapılır.
  // estopTriggeredRef: queueBusy false olunca "görev tamamlandı" yerine "acil dur" event'i yazılması için.
  const emergencyStopNavigation = useCallback(() => {
    cancelActiveNavigationGoal();

    if (busyTimerRef.current) {
      window.clearTimeout(busyTimerRef.current);
      busyTimerRef.current = null;
    }

    pendingStepsRef.current = [];
    activeTaskRef.current = null;
    setActiveTaskProgress(null);
    setCoverageStatus(null);
    skipNextIdleEventRef.current = false;
    clearPlanPath();

    if (estopResetTimerRef.current) {
      window.clearTimeout(estopResetTimerRef.current);
    }

    estopTriggeredRef.current = true;
    setEmergencyStopped(true);
    setQueueBusy(false);

    estopResetTimerRef.current = window.setTimeout(() => {
      setEmergencyStopped(false);
      estopResetTimerRef.current = null;
    }, 4000);
  }, [clearPlanPath]);

  /** Operatör panelinden seçilen görevi başlatır; çok adımlıysa ilk adımı gönderir, gerisini kuyruğa alır. */
  const startTask = useCallback((task) => {
    if (queueBusy || pendingStepsRef.current.length > 0) {
      setShowBusyPopup(true);
      return false;
    }

    const steps = normalizeTaskSteps(task);
    if (steps.length === 0) return false;

    const progress = {
      taskName: task.name || 'Görev',
      currentStep: 1,
      totalSteps: steps.length,
    };

    activeTaskRef.current = {
      ...progress,
      finalAction: task.finalAction,
    };
    setActiveTaskProgress(progress);
    pendingStepsRef.current = steps.length > 1 ? steps.slice(1) : [];

    const sourceLabel = steps.length === 1
      ? `Görev: ${progress.taskName}`
      : `Görev: ${progress.taskName} - Adım 1/${steps.length}`;

    const sent = dispatchGoal(steps[0], sourceLabel);
    if (sent) {
      addEvent(`${progress.taskName} başlatıldı`);
    } else {
      activeTaskRef.current = null;
      setActiveTaskProgress(null);
      pendingStepsRef.current = [];
    }
    return sent;
  }, [addEvent, dispatchGoal, queueBusy]);

  /** Tüm adımlar bittikten sonra "Toprağı Sür" finalAction'ını ROS coverage action ile başlatır. */
  const runFinalActionTill = useCallback(() => {
    setActiveTaskProgress(null);
    setQueueBusy(true);
    wasBusyRef.current = true;

    startCoverageTask(ros, {
      onFeedback: (distanceRemaining, estimatedSeconds) => {
        const distText = distanceRemaining != null
          ? `${Number(distanceRemaining).toFixed(1)} m`
          : '—';
        const secText = estimatedSeconds != null
          ? `~${Math.round(estimatedSeconds)} sn`
          : '—';
        setCoverageStatus(`🌱 Toprak sürülüyor — kalan: ${distText}, ${secText}`);
      },
      onResult: (success, message) => {
        setCoverageStatus(null);
        skipNextIdleEventRef.current = true;
        setQueueBusy(false);
        addEvent(success ? 'Toprak sürme tamamlandı' : message);
      },
    });
  }, [addEvent, ros]);

  // Çok adımlı görevler: Nav2 aynı anda tek hedef işler; kalan adımlar pendingStepsRef'te bekler.
  // Meşgulken yeni görev reddedilir; mevcut adım bitince (timer) sıradaki otomatik dispatchGoal ile gider.
  useEffect(() => {
    if (wasBusyRef.current && !queueBusy) {
      if (skipNextIdleEventRef.current) {
        skipNextIdleEventRef.current = false;
        wasBusyRef.current = queueBusy;
        return;
      }

      if (estopTriggeredRef.current) {
        estopTriggeredRef.current = false;
        clearPlanPath();
        addEvent('Acil dur — navigasyon durduruldu');
        wasBusyRef.current = queueBusy;
        return;  // acil dur — sıradaki adım gönderilmesin
      }

      clearPlanPath();

      const pending = pendingStepsRef.current;
      const activeTask = activeTaskRef.current;

      if (pending.length > 0 && activeTask) {
        const nextStep = pending.shift();  // kuyruktan bir sonraki adımı al
        const currentStep = activeTask.totalSteps - pending.length;
        const progress = {
          ...activeTask,
          currentStep,
        };

        activeTaskRef.current = progress;
        setActiveTaskProgress(progress);

        const sourceLabel = `Görev: ${progress.taskName} - Adım ${currentStep}/${progress.totalSteps}`;
        dispatchGoal(nextStep, sourceLabel);
        addEvent(`Adım ${currentStep}/${progress.totalSteps}: ${progress.taskName}`);
      } else if (activeTask) {
        addEvent(`${activeTask.taskName} tamamlandı`);

        // Navigasyon adımları bitti — görev tanımındaki finalAction'a göre sonraki davranış:
        // wait → hiçbir şey (robot hazır); till → coverage ROS akışı;
        // goto_charge / goto_base → henüz bağlanmadı, Son Olaylar'a bilgi notu
        const finalActionType = activeTask.finalAction?.type || 'wait';
        activeTaskRef.current = null;
        setActiveTaskProgress(null);
        pendingStepsRef.current = [];

        if (finalActionType === 'till') {
          runFinalActionTill();
        } else if (finalActionType === 'goto_charge') {
          console.warn('[finalAction] goto_charge henüz bağlanmadı — mühendisten action/servis bilgisi bekleniyor');
          addEvent('Görev tamamlandı (Şarj İstasyonuna Git henüz aktif değil)');
        } else if (finalActionType === 'goto_base') {
          // TODO: base konumunun gerçek X/Y/Yaw'ı elimize geçince goto_base burada dispatchGoal ile bağlanacak.
          console.warn('[finalAction] goto_base henüz bağlanmadı — base konumu koordinatı bekleniyor');
          addEvent('Görev tamamlandı (Base Konuma Git henüz aktif değil)');
        }
      } else {
        addEvent('Görev tamamlandı');
      }
    }

    wasBusyRef.current = queueBusy;
  }, [addEvent, clearPlanPath, dispatchGoal, queueBusy, runFinalActionTill]);

  // ROS bağlantısı kesilip geri geldiğinde Son Olaylar paneline kayıt düşer.
  useEffect(() => {
    if (!connectionInitializedRef.current) {
      connectionInitializedRef.current = true;
      wasConnectedRef.current = isConnected;
      return;
    }

    if (wasConnectedRef.current && !isConnected) {
      addEvent('Bağlantı kesildi');
    } else if (!wasConnectedRef.current && isConnected) {
      addEvent('Bağlantı geri geldi');
    }
    wasConnectedRef.current = isConnected;
  }, [addEvent, isConnected]);

  // Bileşen kaldırılırken bekleyen timer'ları temizle (bellek sızıntısı önlemi).
  useEffect(() => () => {
    if (busyTimerRef.current) {
      window.clearTimeout(busyTimerRef.current);
    }
    if (estopResetTimerRef.current) {
      window.clearTimeout(estopResetTimerRef.current);
    }
  }, []);

  // useMemo: statusText yalnızca bağımlılıklar değişince yeniden hesaplanır.
  const statusText = useMemo(
    () => getStatusText({ isConnected, emergencyStopped, coverageStatus, queueBusy, activeTaskProgress }),
    [isConnected, emergencyStopped, coverageStatus, queueBusy, activeTaskProgress],
  );

  // useMemo: Context value nesnesinin referansını sabit tutar; gereksiz alt bileşen render'ını azaltır.
  const value = useMemo(
    () => ({
      lastSentGoal,
      queueBusy,
      showBusyPopup,
      setShowBusyPopup,
      sendNavigationGoal,
      startTask,
      emergencyStopNavigation,
      emergencyStopped,
      activeTaskProgress,
      recentEvents,
      statusText,
      isConnected,
    }),
    [
      lastSentGoal,
      queueBusy,
      showBusyPopup,
      sendNavigationGoal,
      startTask,
      emergencyStopNavigation,
      emergencyStopped,
      activeTaskProgress,
      recentEvents,
      statusText,
      isConnected,
    ],
  );

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

/** NavigationProvider dışında kullanılırsa hata fırlatır. */
export function useNavigation() {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error('useNavigation, NavigationProvider içinde kullanılmalıdır.');
  }
  return context;
}
