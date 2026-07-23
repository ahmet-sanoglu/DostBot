// Operatör panelindeki navigasyon akışını yönetir: hedef gönderme, görev kuyruğu, durum metni.
// Nav2'ye tek seferde bir hedef gider; her adıma varınca o step'in action'ı çalışır, sonra sıradaki adım gider.
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
    const base = `🎯 ${activeTaskProgress.taskName} - Adım ${activeTaskProgress.currentStep}/${activeTaskProgress.totalSteps}`;
    if (activeTaskProgress.stepActionLabel) {
      // Büyük durum metninde de eylem görünsün (till sırasında operatör bağlam kaybetmesin)
      return `${base} — ${activeTaskProgress.stepActionLabel}`;
    }
    return base;
  }
  if (queueBusy) {
    return '🎯 Hedefe gidiyor';
  }
  return '✅ Hazır';
}

/** Görev adımlarını koordinat + step action ile normalize eder (kuyruk her adımın eylemini taşır). */
function normalizeTaskSteps(task) {
  if (!Array.isArray(task?.steps)) return [];
  return task.steps
    .filter((step) => typeof step?.x === 'number' && typeof step?.y === 'number')
    .map((step, index, allSteps) => ({
      x: step.x,
      y: step.y,
      yaw: typeof step.yaw === 'number' ? step.yaw : 0,
      action: {
        type: step.action?.type
          || (index === allSteps.length - 1 ? task.finalAction?.type : null)
          || 'wait',
      },
    }));
}

/** Nav2 hedef mesajı için yalnızca koordinat alanlarını ayırır. */
function stepToGoal(step) {
  return { x: step.x, y: step.y, yaw: step.yaw };
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

  const busyTimerRef = useRef(null);
  const estopResetTimerRef = useRef(null);
  const wasBusyRef = useRef(false);
  const estopTriggeredRef = useRef(false);
  const skipNextIdleEventRef = useRef(false);
  const inStepActionRef = useRef(false);  // till gibi uzun eylem sürerken nav-tamamlandı effect'ini yutar
  const wasConnectedRef = useRef(status === ROS_CONNECTED_STATUS);
  const connectionInitializedRef = useRef(false);
  const pendingStepsRef = useRef([]);
  const activeTaskRef = useRef(null);
  const proceedAfterStepActionRef = useRef(null);

  const isConnected = status === ROS_CONNECTED_STATUS;

  const addEvent = useCallback((message) => {
    const entry = {
      id: crypto.randomUUID(),
      time: formatEventTime(),
      message,
    };
    setRecentEvents((prev) => [entry, ...prev].slice(0, MAX_EVENTS));
  }, []);

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

  const sendNavigationGoal = useCallback((goal, sourceLabel) => {
    if (queueBusy || pendingStepsRef.current.length > 0 || activeTaskRef.current) {
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
    inStepActionRef.current = false;
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

  /** Step eylemi bittikten sonra kuyruktaki bir sonraki navigasyon hedefini gönderir veya görevi kapatır. */
  const proceedAfterStepAction = useCallback(() => {
    const activeTask = activeTaskRef.current;
    if (!activeTask) return;

    const pending = pendingStepsRef.current;
    if (pending.length > 0) {
      const nextStep = pending.shift();
      const currentStep = activeTask.totalSteps - pending.length;
      const progress = {
        ...activeTask,
        currentStep,
        stepActionLabel: null,
      };

      activeTaskRef.current = progress;
      setActiveTaskProgress(progress);

      const sourceLabel = `Görev: ${progress.taskName} - Adım ${currentStep}/${progress.totalSteps}`;
      dispatchGoal(stepToGoal(nextStep), sourceLabel);
      addEvent(`Adım ${currentStep}/${progress.totalSteps}: ${progress.taskName}`);
      return;
    }

    addEvent(`${activeTask.taskName} tamamlandı`);
    activeTaskRef.current = null;
    setActiveTaskProgress(null);
    pendingStepsRef.current = [];
    setQueueBusy(false);
    skipNextIdleEventRef.current = true;
  }, [addEvent, dispatchGoal]);

  proceedAfterStepActionRef.current = proceedAfterStepAction;

  /**
   * Ulaşılan step'in action.type değerini çalıştırır — sıradaki step'in değil.
   * till: onResult gelene kadar bekler, sonra proceed; goto_*: şimdilik uyarı + hemen proceed
   * (ileride till gibi ROS bitene kadar bekleyecek).
   */
  const runStepAction = useCallback((actionType, stepNumber, taskName) => {
    const proceed = () => proceedAfterStepActionRef.current?.();

    if (!actionType || actionType === 'wait') {
      proceed();
      return;
    }

    if (actionType === 'till') {
      inStepActionRef.current = true;
      setQueueBusy(true);
      wasBusyRef.current = true;
      setActiveTaskProgress((prev) => (
        prev ? { ...prev, stepActionLabel: '🌱 Toprak sürülüyor' } : prev
      ));

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
          setActiveTaskProgress((prev) => (
            prev ? { ...prev, stepActionLabel: null } : prev
          ));
          addEvent(success ? `Adım ${stepNumber}: Toprak sürme tamamlandı` : message);
          inStepActionRef.current = false;
          proceed();
        },
      });
      return;
    }

    if (actionType === 'goto_charge') {
      // İleride till gibi ROS action bitene kadar bekleyip proceed çağrılacak
      console.warn('[stepAction] goto_charge henüz bağlanmadı — mühendisten action/servis bilgisi bekleniyor');
      addEvent(`Adım ${stepNumber}: Şarj İstasyonuna Git henüz aktif değil (${taskName})`);
      proceed();
      return;
    }

    if (actionType === 'goto_base') {
      // İleride till gibi base koordinatına gidilip bitene kadar bekleyip proceed çağrılacak
      console.warn('[stepAction] goto_base henüz bağlanmadı — base konumu koordinatı bekleniyor');
      addEvent(`Adım ${stepNumber}: Base Konuma Git henüz aktif değil (${taskName})`);
      proceed();
      return;
    }

    proceed();
  }, [addEvent, ros]);

  /** Nav2 hedefi tamamlandı (timer) — az önce varılan noktanın eylemini tetikler. */
  const handleNavigationArrived = useCallback(() => {
    const activeTask = activeTaskRef.current;
    if (!activeTask) {
      addEvent('Görev tamamlandı');
      return;
    }

    const step = activeTask.steps?.[activeTask.currentStep - 1];
    const actionType = step?.action?.type || 'wait';
    runStepAction(actionType, activeTask.currentStep, activeTask.taskName);
  }, [addEvent, runStepAction]);

  const startTask = useCallback((task) => {
    if (queueBusy || pendingStepsRef.current.length > 0 || activeTaskRef.current) {
      setShowBusyPopup(true);
      return false;
    }

    const steps = normalizeTaskSteps(task);
    if (steps.length === 0) return false;

    const progress = {
      taskName: task.name || 'Görev',
      currentStep: 1,
      totalSteps: steps.length,
      stepActionLabel: null,
    };

    activeTaskRef.current = {
      ...progress,
      steps,
    };
    setActiveTaskProgress(progress);
    pendingStepsRef.current = steps.length > 1 ? steps.slice(1) : [];

    const sourceLabel = steps.length === 1
      ? `Görev: ${progress.taskName}`
      : `Görev: ${progress.taskName} - Adım 1/${steps.length}`;

    const sent = dispatchGoal(stepToGoal(steps[0]), sourceLabel);
    if (sent) {
      addEvent(`${progress.taskName} başlatıldı`);
    } else {
      activeTaskRef.current = null;
      setActiveTaskProgress(null);
      pendingStepsRef.current = [];
    }
    return sent;
  }, [addEvent, dispatchGoal, queueBusy]);

  // queueBusy false: navigasyon bitti → ulaşılan step'in eylemi → eylem bitince sıradaki step veya görev sonu
  useEffect(() => {
    if (wasBusyRef.current && !queueBusy) {
      if (skipNextIdleEventRef.current) {
        skipNextIdleEventRef.current = false;
        wasBusyRef.current = queueBusy;
        return;
      }

      if (inStepActionRef.current) {
        wasBusyRef.current = queueBusy;
        return;
      }

      if (estopTriggeredRef.current) {
        estopTriggeredRef.current = false;
        clearPlanPath();
        addEvent('Acil dur — navigasyon durduruldu');
        wasBusyRef.current = queueBusy;
        return;
      }

      clearPlanPath();

      if (activeTaskRef.current) {
        handleNavigationArrived();
      } else {
        addEvent('Görev tamamlandı');
      }
    }

    wasBusyRef.current = queueBusy;
  }, [addEvent, clearPlanPath, handleNavigationArrived, queueBusy]);

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

  useEffect(() => () => {
    if (busyTimerRef.current) {
      window.clearTimeout(busyTimerRef.current);
    }
    if (estopResetTimerRef.current) {
      window.clearTimeout(estopResetTimerRef.current);
    }
  }, []);

  const statusText = useMemo(
    () => getStatusText({ isConnected, emergencyStopped, coverageStatus, queueBusy, activeTaskProgress }),
    [isConnected, emergencyStopped, coverageStatus, queueBusy, activeTaskProgress],
  );

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

export function useNavigation() {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error('useNavigation, NavigationProvider içinde kullanılmalıdır.');
  }
  return context;
}
