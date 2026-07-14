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
import { publishNavigationGoal } from '../utils/rosNavigation';

const NAV_BUSY_MS = 8000;
const MAX_EVENTS = 10;

const NavigationContext = createContext(null);

function formatEventTime(date = new Date()) {
  return date.toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function getStatusText({ isConnected, queueBusy, activeTaskProgress }) {
  if (!isConnected) {
    return '⚠️ Bağlantı Yok';
  }
  if (queueBusy && activeTaskProgress) {
    return `🎯 ${activeTaskProgress.taskName} - Adım ${activeTaskProgress.currentStep}/${activeTaskProgress.totalSteps}`;
  }
  if (queueBusy) {
    return '🎯 Hedefe gidiyor';
  }
  return '✅ Hazır';
}

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
  const busyTimerRef = useRef(null);
  const wasBusyRef = useRef(false);
  const wasConnectedRef = useRef(status === ROS_CONNECTED_STATUS);
  const connectionInitializedRef = useRef(false);
  const pendingStepsRef = useRef([]);
  const activeTaskRef = useRef(null);

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

    activeTaskRef.current = progress;
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

  useEffect(() => {
    if (wasBusyRef.current && !queueBusy) {
      clearPlanPath();

      const pending = pendingStepsRef.current;
      const activeTask = activeTaskRef.current;

      if (pending.length > 0 && activeTask) {
        const nextStep = pending.shift();
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
        activeTaskRef.current = null;
        setActiveTaskProgress(null);
        pendingStepsRef.current = [];
      } else {
        addEvent('Görev tamamlandı');
      }
    }

    wasBusyRef.current = queueBusy;
  }, [addEvent, clearPlanPath, dispatchGoal, queueBusy]);

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
  }, []);

  const statusText = useMemo(
    () => getStatusText({ isConnected, queueBusy, activeTaskProgress }),
    [isConnected, queueBusy, activeTaskProgress],
  );

  const value = useMemo(
    () => ({
      lastSentGoal,
      queueBusy,
      showBusyPopup,
      setShowBusyPopup,
      sendNavigationGoal,
      startTask,
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
