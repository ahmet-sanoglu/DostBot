// Operatör panelindeki navigasyon akışını yönetir: hedef gönderme, görev kuyruğu, durum metni.
// Hedefler nav_relay.py üzerinden Nav2'ye gider; durum /agrifleet/nav_status JSON ile gelir.
// Nav2'ye tek seferde bir hedef; her adıma varınca step action, sonra sıradaki adım.
// skipNextIdleEventRef: görev bitiş idle'sı sonraki görevin Adım1→2 geçişini yutmasın diye
// startTask/sendNavigationGoal başında sıfırlanır (queueBusy zaten false iken bayrak kilitlenirdi).
// Görev geçmişi: runId ile başlat/bitir POST'ları bağlanır; 'Hedef' fallback yazılmaz.

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
import { appendMapTaskHistory, fetchActiveMap } from '../utils/mapApi';
import {
  publishNavSnapshot,
  publishTaskHistoryUpdated,
} from '../utils/navigationBroadcast';

/** accepted hiç gelmezse (röle yok / bag) kısa kaçış; UI sonsuza kadar meşgul kalmasın diye. */
const NAV_BUSY_MS = 10000;
/** accepted geldiyse röle çalışıyor demektir; bundan sonra yalnızca gerçek takılma için son çare. */
const NAV_ACCEPTED_SAFETY_MS = 120000;
/** Geçmiş sayfasını yenileyecek terminal kayıt durumları. */
const HISTORY_TERMINAL_STATUSES = new Set(['başarılı', 'iptal edildi', 'başarısız']);

/** action_msgs/GoalStatus — röle result.status alanıyla aynı. */
const NAV_RESULT_SUCCEEDED = 4;
const NAV_RESULT_CANCELED = 5;
const NAV_RESULT_ABORTED = 6;

const NavigationContext = createContext(null);


/** Backend task-history ISO zaman damgası (saniye hassasiyeti). */
function historyTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
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
  const [activeTaskProgress, setActiveTaskProgress] = useState(null);
  const [emergencyStopped, setEmergencyStopped] = useState(false);
  const [coverageStatus, setCoverageStatus] = useState(null);
  const [navDistanceRemaining, setNavDistanceRemaining] = useState(null);
  // MapView geçmiş izini temizlemek için — startTask/sendNavigationGoal'ta artar
  const [mapTrailResetKey, setMapTrailResetKey] = useState(0);
  // Kontrol Paneli kart tıklaması — haritada rota önizlemesi (navigasyon değil)
  const [previewTask, setPreviewTask] = useState(null);
  // Nav2 number_of_recoveries — engelde kurtarma manevrası sayacı.
  // Neden UI'ye? Görev iptal edilmez ama operatör "takıldı mı?" görsün (StatusCard).
  const [recoveryCount, setRecoveryCount] = useState(0);

  const estopResetTimerRef = useRef(null);
  const busyTimerRef = useRef(null);  // NAV_BUSY_MS yedek; result/rejected gelince clearTimeout
  const wasBusyRef = useRef(false);
  const estopTriggeredRef = useRef(false);
  // Tek atımlık: görev bitişi / rejected sonrası setQueueBusy(false) idle effect'ini
  // "Görev tamamlandı" diye çift tetiklemesin diye bir sonraki busy→idle'ı yutar.
  // Kritik: queueBusy zaten false iken set edilirse effect çalışmaz, bayrak true kalır;
  // sonraki FARKLI görevin ilk Adım1→2 geçişi yanlışlıkla atlanır → startTask/sendNavigationGoal başında sıfırlanmalı.
  const skipNextIdleEventRef = useRef(false);
  const inStepActionRef = useRef(false);  // till gibi uzun eylem sürerken nav-tamamlandı effect'ini yutar
  const queueBusyRef = useRef(false);
  const pendingStepsRef = useRef([]);
  const activeTaskRef = useRef(null);
  const proceedAfterStepActionRef = useRef(null);
  // Görev geçmişi: nav state makinesine paralel yan log (await yok → UI bloklanmaz)
  const historyMapIdRef = useRef(null);
  // Çok adımlı görevde her accepted'ta "başlatıldı" yazılmasın
  const historyStartLoggedRef = useRef(false);
  // Acil dur zaten iptal kaydı yazdıysa CANCELED result çift satır üretmesin
  const historySkipNextCancelRef = useRef(false);
  // Aynı run'ın başlatıldı + terminal POST'larını bağlar (FIFO off-by-one önler)
  const currentRunIdRef = useRef(null);
  const lastSentGoalRef = useRef(null);
  // Görev geçmişi sekmesi için: busy başladığı an (activeTask.startedAt yoksa)
  const navStartedAtRef = useRef(null);

  const isConnected = status === ROS_CONNECTED_STATUS;

  queueBusyRef.current = queueBusy;

  // Görev Geçmişi yeni sekmede — canlı "Devam Ediyor" + bitişte liste yenileme için yayın
  useEffect(() => {
    if (!queueBusy) {
      navStartedAtRef.current = null;
    }
    publishNavSnapshot({
      queueBusy,
      activeTaskProgress,
      lastSentGoal,
      navStartedAt: activeTaskProgress?.startedAt || navStartedAtRef.current,
    });
  }, [queueBusy, activeTaskProgress, lastSentGoal]);

  // busy → idle: geçmiş sekmesi GET yenilesin (POST ile yarışmasın diye kısa gecikme)
  const wasQueueBusyRef = useRef(false);
  useEffect(() => {
    if (wasQueueBusyRef.current && !queueBusy) {
      const timer = window.setTimeout(() => {
        publishTaskHistoryUpdated({ status: 'idle' });
      }, 450);
      wasQueueBusyRef.current = false;
      return () => window.clearTimeout(timer);
    }
    if (queueBusy) {
      wasQueueBusyRef.current = true;
    }
    return undefined;
  }, [queueBusy]);

  const clearBusyTimer = useCallback(() => {
    if (busyTimerRef.current) {
      window.clearTimeout(busyTimerRef.current);
      busyTimerRef.current = null;
    }
  }, []);

  const resetRecoveryState = useCallback(() => {
    setRecoveryCount(0);
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


  /** Aktif görev veya son hedef etiketinden geçmiş kaydı için isim.
   *  'Hedef' = gerçek görev adı yok (fallback); logTaskHistory bu değeri yazmaz. */
  const resolveHistoryTaskName = useCallback(() => {
    const active = activeTaskRef.current;
    if (active?.taskName) return active.taskName;
    const source = lastSentGoalRef.current?.source;
    if (typeof source === 'string' && source.trim()) {
      const match = source.match(/^Görev:\s*(.+?)(?:\s*-\s*Adım\s+\d|$)/);
      return match ? match[1].trim() : source;
    }
    return 'Hedef';
  }, []);

  /**
   * Görev geçmişi POST — fire-and-forget.
   * Neden ayrı? Nav accepted/result akışını bozmadan denetim izi; hata olursa
   * yalnızca console.warn, queueBusy/step zinciri etkilenmez.
   * runId: başlatıldı'da yeni UUID; terminal'de aynı id — backend FIFO yerine buna göre birleştirir.
   */
  const logTaskHistory = useCallback((status, taskName) => {
    const name = (taskName && String(taskName).trim()) || resolveHistoryTaskName();
    // Sahte kayıt: activeTask yok + source yok → fallback 'Hedef'; hiç yazma
    if (!name || name === 'Hedef') return;

    let runId = currentRunIdRef.current;
    if (status === 'başlatıldı') {
      runId = crypto.randomUUID();
      currentRunIdRef.current = runId;
    } else {
      // Terminal: start ile aynı runId; yoksa (accepted öncesi estop) yine benzersiz id
      if (!runId) {
        runId = crypto.randomUUID();
      }
      currentRunIdRef.current = null; // bir daha kullanılmasın
    }

    void (async () => {
      try {
        let mapId = historyMapIdRef.current;
        if (!mapId) {
          const map = await fetchActiveMap();
          mapId = map?.id;
          if (mapId) historyMapIdRef.current = mapId;
        }
        if (!mapId) return;
        await appendMapTaskHistory(mapId, {
          taskName: name,
          status,
          timestamp: historyTimestamp(),
          runId,
        });
        // POST bitti → açık Görev Geçmişi sekmesi Tamamlandı/İptal listesini çeksin
        if (HISTORY_TERMINAL_STATUSES.has(status)) {
          publishTaskHistoryUpdated({ status, taskName: name });
        }
      } catch (err) {
        console.warn('[taskHistory] kayıt gönderilemedi:', err);
      }
    })();
  }, [resolveHistoryTaskName]);

  const dispatchGoal = useCallback((goal, sourceLabel) => {
    const sent = publishNavigationGoal(ros, goal);
    if (!sent) return false;

    clearPlanPath();
    const sentGoal = { ...goal, source: sourceLabel };
    lastSentGoalRef.current = sentGoal;
    setLastSentGoal(sentGoal);
    setNavDistanceRemaining(null);
    resetRecoveryState();
    // Katman 1: kısa fallback. Röle hiç çalışmıyorsa / accepted gelmiyorsa bag testinde çıkış yolu bu.
    // accepted gelirse bu 10 sn timer uzun güvenlik ağıyla değiştirilecek.
    if (!navStartedAtRef.current) {
      navStartedAtRef.current = historyTimestamp();
    }
    setQueueBusy(true);
    startBusyTimer(NAV_BUSY_MS);

    return true;
  }, [clearPlanPath, resetRecoveryState, ros, startBusyTimer]);

  const emergencyStopNavigation = useCallback(() => {
    // İptal kaydı — state temizlenmeden önce isim alınır (yan log; nav akışını değiştirmez)
    const hadWork = Boolean(activeTaskRef.current) || queueBusyRef.current;
    const stopName = resolveHistoryTaskName();

    cancelActiveNavigationGoal(ros);

    clearBusyTimer();
    pendingStepsRef.current = [];
    activeTaskRef.current = null;
    setActiveTaskProgress(null);
    setPreviewTask(null);
    setCoverageStatus(null);
    setNavDistanceRemaining(null);
    skipNextIdleEventRef.current = false; // estop sonrası idle zinciri temiz başlasın
    inStepActionRef.current = false;
    historyStartLoggedRef.current = false;
    resetRecoveryState();
    clearPlanPath();

    if (hadWork) {
      historySkipNextCancelRef.current = true;
      logTaskHistory('iptal edildi', stopName);
    }

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
  }, [clearBusyTimer, clearPlanPath, logTaskHistory, resetRecoveryState, resolveHistoryTaskName, ros]);

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
      return;
    }

    // Kuyruk boş → görev bitti: activeTask kilidini mutlaka düşür (yoksa startTask sonsuza meşgul kalır)
    logTaskHistory('başarılı', activeTask.taskName);
    historyStartLoggedRef.current = false;
    activeTaskRef.current = null;
    setActiveTaskProgress(null);
    pendingStepsRef.current = [];
    inStepActionRef.current = false;
    setQueueBusy(false);
    // Bu idle'ı yut: activeTask zaten null; effect "Görev tamamlandı" diye tekrar yazmasın.
    // Tek atımlık — yeni görev startTask'ta false'a çekilmezse sonraki görevin ilk idle'ı da yutulur.
    skipNextIdleEventRef.current = true;
  }, [dispatchGoal, logTaskHistory]);

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
          inStepActionRef.current = false;
          proceed();
        },
      });
      return;
    }

    if (actionType === 'goto_charge') {
      console.warn('[stepAction] goto_charge henüz bağlanmadı — mühendisten action/servis bilgisi bekleniyor');
      proceed();
      return;
    }

    if (actionType === 'goto_base') {
      console.warn('[stepAction] goto_base henüz bağlanmadı — base konumu koordinatı bekleniyor');
      proceed();
      return;
    }

    proceed();
  }, [ros]);

  /** Nav hedefi tamamlandı (röle result) — az önce varılan noktanın eylemini tetikler. */
  const handleNavigationArrived = useCallback(() => {
    const activeTask = activeTaskRef.current;
    if (!activeTask) {
      return;
    }

    const step = activeTask.steps?.[activeTask.currentStep - 1];
    const actionType = step?.action?.type || 'wait';
    runStepAction(actionType, activeTask.currentStep, activeTask.taskName);
  }, [runStepAction]);

  /**
   * Yalnızca kullanıcı yeni görev/hedef başlatırken çağrılır.
   * Nav zincirine (result → idle → proceed) karışmaz; ara adımlarda activeTask silinmez.
   * queueBusy kapalı + kuyruk boş + eylem yok iken kalan activeTask = stale kilit.
   */
  const clearStaleActiveTaskIfIdle = useCallback(() => {
    if (
      queueBusy
      || pendingStepsRef.current.length > 0
      || inStepActionRef.current
    ) {
      return;
    }
    if (activeTaskRef.current) {
      activeTaskRef.current = null;
      setActiveTaskProgress(null);
    }
  }, [queueBusy]);

  const sendNavigationGoal = useCallback((goal, sourceLabel) => {
    // Önceki görev bitişinde true kalan skip, bu hedefin (veya sonraki görevin) idle zincirini
    // yanlışlıkla atlamasın — her yeni hedef temiz bayrakla başlamalı.
    skipNextIdleEventRef.current = false;
    clearStaleActiveTaskIfIdle();
    if (queueBusy || pendingStepsRef.current.length > 0 || activeTaskRef.current) {
      setShowBusyPopup(true);
      return false;
    }

    // Yeni hedef: eski görev izi/rotası haritada kalmasın
    setMapTrailResetKey((key) => key + 1);
    setPreviewTask(null);
    activeTaskRef.current = null;
    setActiveTaskProgress(null);
    pendingStepsRef.current = [];
    historyStartLoggedRef.current = false;

    const sent = dispatchGoal(goal, sourceLabel);
    return sent;
  }, [clearStaleActiveTaskIfIdle, dispatchGoal, queueBusy]);

  const startTask = useCallback((task) => {
    // Kritik sıfırlama: önceki görevin (ör. "Base'e Git") bitişinde true kalan skipNextIdleEvent,
    // queueBusy zaten false olduğu için idle effect'te tüketilmemiş olabilir. Tüketilmezse
    // bu yeni görevin kendi ilk busy→idle geçişi (çok adımlı: Adım 1→2) yanlışlıkla atlanır.
    // Bayrak yalnızca "bir sonraki idle" içindir; her yeni görev temiz başlamalı.
    skipNextIdleEventRef.current = false;
    clearStaleActiveTaskIfIdle();
    if (queueBusy || pendingStepsRef.current.length > 0 || activeTaskRef.current) {
      setShowBusyPopup(true);
      return false;
    }

    const steps = normalizeTaskSteps(task);
    if (steps.length === 0) return false;

    // Önceki görevin kırmızı izi birikmesin; gelecek rota activeTaskProgress ile yenilenir
    setMapTrailResetKey((key) => key + 1);
    setPreviewTask(null); // gerçek navigasyon başlarken önizleme kapansın
    historyStartLoggedRef.current = false;

    const progress = {
      taskName: task.name || 'Görev',
      currentStep: 1,
      totalSteps: steps.length,
      stepActionLabel: null,
      steps,
      startedAt: historyTimestamp(),
    };

    activeTaskRef.current = progress;
    setActiveTaskProgress(progress);
    pendingStepsRef.current = steps.length > 1 ? steps.slice(1) : [];

    const sourceLabel = steps.length === 1
      ? `Görev: ${progress.taskName}`
      : `Görev: ${progress.taskName} - Adım 1/${steps.length}`;

    const sent = dispatchGoal(stepToGoal(steps[0]), sourceLabel);
    if (!sent) {
      activeTaskRef.current = null;
      setActiveTaskProgress(null);
      pendingStepsRef.current = [];
    }
    return sent;
  }, [clearStaleActiveTaskIfIdle, dispatchGoal, queueBusy]);

  // /agrifleet/nav_status — tek güvenilir kaynak (nav_relay); status_list / ID tahmini yok
  useEffect(() => {
    if (!ros || !isConnected) return undefined;

    return subscribeNavigationStatus(ros, (message) => {
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'accepted') {
        // Katman 2: accepted, nav_relay'in gerçekten canlı olduğunu kanıtlar. Bu noktadan sonra
        // 10 sn fallback erken "Hazır" üretmemeli; onun yerine yalnızca robot tamamen takılırsa
        // devreye girecek 120 sn uzun güvenlik ağına geçilir.
        startBusyTimer(NAV_ACCEPTED_SAFETY_MS);
        // Yan kayıt: görev başına bir kez "başlatıldı" (çok adımlı görevlerde spam olmasın)
        if (!historyStartLoggedRef.current) {
          historyStartLoggedRef.current = true;
          logTaskHistory('başlatıldı');
        }
        return;
      }

      if (message.type === 'feedback') {
        if (typeof message.distance_remaining === 'number') {
          setNavDistanceRemaining(message.distance_remaining);
        }
        if (typeof message.number_of_recoveries === 'number') {
          const count = message.number_of_recoveries;
          setRecoveryCount(count);
        }
        return;
      }

      if (message.type === 'rejected') {
        console.warn('[navStatus] rejected');
        const rejectedName = resolveHistoryTaskName();
        clearBusyTimer();
        setNavDistanceRemaining(null);
        resetRecoveryState();
        pendingStepsRef.current = [];
        activeTaskRef.current = null;
        setActiveTaskProgress(null);
        skipNextIdleEventRef.current = true; // rejected sonrası idle "tamamlandı" spam'i olmasın
        historyStartLoggedRef.current = false;
        logTaskHistory('başarısız', rejectedName);
        setQueueBusy(false);
        return;
      }

      if (message.type === 'result') {
        if (inStepActionRef.current) return;
        if (!queueBusyRef.current) return;

        const resultStatus = message.status;
        clearBusyTimer();
        setNavDistanceRemaining(null);
        resetRecoveryState();

        // Yan kayıt: terminal sonuçlar; çok adımlı görevde SUCCEEDED → proceedAfterStepAction'da
        if (resultStatus === NAV_RESULT_CANCELED) {
          if (historySkipNextCancelRef.current) {
            historySkipNextCancelRef.current = false;
          } else {
            logTaskHistory('iptal edildi');
          }
          historyStartLoggedRef.current = false;
        } else if (resultStatus === NAV_RESULT_ABORTED) {
          logTaskHistory('başarısız');
          historyStartLoggedRef.current = false;
        } else if (resultStatus === NAV_RESULT_SUCCEEDED && !activeTaskRef.current) {
          logTaskHistory('başarılı');
          historyStartLoggedRef.current = false;
        }

        // 4=SUCCEEDED, 5=CANCELED, 6=ABORTED — meşguliyeti kapat; adım zinciri idle effect'e bırakılır
        // (stale temizleme burada YOK — ara adımlarda activeTask'i silmemek için)
        if (
          resultStatus === NAV_RESULT_SUCCEEDED
          || resultStatus === NAV_RESULT_CANCELED
          || resultStatus === NAV_RESULT_ABORTED
        ) {
          setQueueBusy(false);
        }
      }
    });
  }, [
    clearBusyTimer,
    isConnected,
    logTaskHistory,
    resetRecoveryState,
    resolveHistoryTaskName,
    ros,
    startBusyTimer,
  ]);

  // queueBusy false: navigasyon bitti → ulaşılan step'in eylemi → eylem bitince sıradaki step veya görev sonu
  useEffect(() => {
    if (wasBusyRef.current && !queueBusy) {
      if (skipNextIdleEventRef.current) {
        // Tek kullanım: yuttuktan sonra mutlaka false — aksi halde sonraki idle'lar da atlanır
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
        wasBusyRef.current = queueBusy;
        return;
      }

      clearPlanPath();

      if (activeTaskRef.current) {
        handleNavigationArrived();
      }
    }

    wasBusyRef.current = queueBusy;
  }, [clearPlanPath, handleNavigationArrived, queueBusy]);

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
      mapTrailResetKey,
      previewTask,
      setPreviewTask,
      recoveryCount,
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
      mapTrailResetKey,
      previewTask,
      recoveryCount,
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
