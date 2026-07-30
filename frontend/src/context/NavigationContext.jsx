// Operatör panelindeki navigasyon akışını yönetir: hedef gönderme, görev kuyruğu, durum metni.
// Hedefler nav_relay.py üzerinden Nav2'ye gider; durum /agrifleet/nav_status JSON ile gelir.
// Nav2'ye tek seferde bir hedef; her adıma varınca step action, sonra sıradaki adım.

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
import {
  cancelActiveNavigationGoal,
  publishNavigationGoal,
  subscribeNavigationStatus,
} from '../utils/rosNavigation';
import { startCoverageTask } from '../utils/coverageAction';

/** accepted hiç gelmezse (röle yok / bag) kısa kaçış; UI sonsuza kadar meşgul kalmasın diye. */
const NAV_BUSY_MS = 10000;
/** accepted geldiyse röle çalışıyor demektir; bundan sonra yalnızca gerçek takılma için son çare. */
const NAV_ACCEPTED_SAFETY_MS = 120000;
const MAX_EVENTS = 10;

/** action_msgs/GoalStatus — röle result.status alanıyla aynı. */
const NAV_RESULT_SUCCEEDED = 4;
const NAV_RESULT_CANCELED = 5;
const NAV_RESULT_ABORTED = 6;

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
export function getStatusText({
  isConnected,
  emergencyStopped,
  coverageStatus,
  queueBusy,
  activeTaskProgress,
  navDistanceRemaining,
}) {
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
      return `${base} — ${activeTaskProgress.stepActionLabel}`;
    }
    if (navDistanceRemaining != null) {
      return `${base} — kalan: ${Number(navDistanceRemaining).toFixed(1)} m`;
    }
    return base;
  }
  if (queueBusy) {
    if (navDistanceRemaining != null) {
      return `🎯 Hedefe gidiyor — kalan: ${Number(navDistanceRemaining).toFixed(1)} m`;
    }
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
  const [navDistanceRemaining, setNavDistanceRemaining] = useState(null);

  const estopResetTimerRef = useRef(null);
  const busyTimerRef = useRef(null);  // NAV_BUSY_MS yedek; result/rejected gelince clearTimeout
  const wasBusyRef = useRef(false);
  const estopTriggeredRef = useRef(false);
  const skipNextIdleEventRef = useRef(false);
  const inStepActionRef = useRef(false);  // till gibi uzun eylem sürerken nav-tamamlandı effect'ini yutar
  const queueBusyRef = useRef(false);
  const wasConnectedRef = useRef(status === ROS_CONNECTED_STATUS);
  const connectionInitializedRef = useRef(false);
  const pendingStepsRef = useRef([]);
  const activeTaskRef = useRef(null);
  const proceedAfterStepActionRef = useRef(null);

  const isConnected = status === ROS_CONNECTED_STATUS;

  queueBusyRef.current = queueBusy;

  const clearBusyTimer = useCallback(() => {
    if (busyTimerRef.current) {
      window.clearTimeout(busyTimerRef.current);
      busyTimerRef.current = null;
    }
  }, []);

  const startBusyTimer = useCallback((timeoutMs) => {
    // Tek timer ref tutulur; kısa fallback ile uzun safety ağı birbirinin yerine geçer.
    clearBusyTimer();
    busyTimerRef.current = window.setTimeout(() => {
      busyTimerRef.current = null;
      if (inStepActionRef.current) return;
      setNavDistanceRemaining(null);
      setQueueBusy(false);
    }, timeoutMs);
  }, [clearBusyTimer]);

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
    setNavDistanceRemaining(null);
    // Katman 1: kısa fallback. Röle hiç çalışmıyorsa / accepted gelmiyorsa bag testinde çıkış yolu bu.
    // accepted gelirse bu 10 sn timer uzun güvenlik ağıyla değiştirilecek.
    setQueueBusy(true);
    startBusyTimer(NAV_BUSY_MS);

    return true;
  }, [clearPlanPath, ros, startBusyTimer]);

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
      addEvent(sourceLabel || 'Hedefe gidiyor');
    }
    return sent;
  }, [addEvent, dispatchGoal, queueBusy]);

  const emergencyStopNavigation = useCallback(() => {
    cancelActiveNavigationGoal(ros);

    clearBusyTimer();
    pendingStepsRef.current = [];
    activeTaskRef.current = null;
    setActiveTaskProgress(null);
    setCoverageStatus(null);
    setNavDistanceRemaining(null);
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
  }, [clearBusyTimer, clearPlanPath, ros]);

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
   * till: onResult gelene kadar bekler, sonra proceed; goto_*: şimdilik uyarı + hemen proceed.
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
      console.warn('[stepAction] goto_charge henüz bağlanmadı — mühendisten action/servis bilgisi bekleniyor');
      addEvent(`Adım ${stepNumber}: Şarj İstasyonuna Git henüz aktif değil (${taskName})`);
      proceed();
      return;
    }

    if (actionType === 'goto_base') {
      console.warn('[stepAction] goto_base henüz bağlanmadı — base konumu koordinatı bekleniyor');
      addEvent(`Adım ${stepNumber}: Base Konuma Git henüz aktif değil (${taskName})`);
      proceed();
      return;
    }

    proceed();
  }, [addEvent, ros]);

  /** Nav hedefi tamamlandı (röle result) — az önce varılan noktanın eylemini tetikler. */
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
      steps,
    };

    activeTaskRef.current = progress;
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

  // /agrifleet/nav_status — tek güvenilir kaynak (nav_relay); status_list / ID tahmini yok
  useEffect(() => {
    if (!ros || !isConnected) return undefined;

    return subscribeNavigationStatus(ros, (message) => {
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'accepted') {
        console.log('[navStatus] accepted');
        // Katman 2: accepted, nav_relay'in gerçekten canlı olduğunu kanıtlar. Bu noktadan sonra
        // 10 sn fallback erken "Hazır" üretmemeli; onun yerine yalnızca robot tamamen takılırsa
        // devreye girecek 120 sn uzun güvenlik ağına geçilir.
        startBusyTimer(NAV_ACCEPTED_SAFETY_MS);
        return;
      }

      if (message.type === 'feedback') {
        if (typeof message.distance_remaining === 'number') {
          setNavDistanceRemaining(message.distance_remaining);
        }
        return;
      }

      if (message.type === 'rejected') {
        console.warn('[navStatus] rejected');
        clearBusyTimer();
        setNavDistanceRemaining(null);
        pendingStepsRef.current = [];
        activeTaskRef.current = null;
        setActiveTaskProgress(null);
        skipNextIdleEventRef.current = true;
        addEvent('Hedef reddedildi');
        setQueueBusy(false);
        return;
      }

      if (message.type === 'result') {
        if (inStepActionRef.current) return;
        if (!queueBusyRef.current) return;

        const resultStatus = message.status;
        console.log('[navStatus] result status:', resultStatus);
        clearBusyTimer();
        setNavDistanceRemaining(null);

        // 4=SUCCEEDED, 5=CANCELED, 6=ABORTED — hepsi meşguliyeti kapatır; zincir effect'e bırakılır
        if (
          resultStatus === NAV_RESULT_SUCCEEDED
          || resultStatus === NAV_RESULT_CANCELED
          || resultStatus === NAV_RESULT_ABORTED
        ) {
          setQueueBusy(false);
        }
      }
    });
  }, [addEvent, clearBusyTimer, isConnected, ros, startBusyTimer]);

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
    clearBusyTimer();
    if (estopResetTimerRef.current) {
      window.clearTimeout(estopResetTimerRef.current);
    }
  }, [clearBusyTimer]);

  const statusText = useMemo(
    () => getStatusText({
      isConnected,
      emergencyStopped,
      coverageStatus,
      queueBusy,
      activeTaskProgress,
      navDistanceRemaining,
    }),
    [isConnected, emergencyStopped, coverageStatus, queueBusy, activeTaskProgress, navDistanceRemaining],
  );

  // currentStep'ten sona kalan hedefler — MapView drawUpcomingRoute için.
  // Adım ilerledikçe slice kayar; tamamlanan nokta listeden düşer (ayrı "sil" animasyonu gerekmez).
  const activeTaskRemainingSteps = useMemo(() => {
    const steps = activeTaskProgress?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      return [];
    }
    const from = Math.max(0, (activeTaskProgress.currentStep || 1) - 1);
    return steps.slice(from).map((step) => ({ x: step.x, y: step.y }));
  }, [activeTaskProgress]);

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
      activeTaskRemainingSteps,
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
      activeTaskRemainingSteps,
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
