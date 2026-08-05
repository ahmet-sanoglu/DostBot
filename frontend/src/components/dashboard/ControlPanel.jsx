// Operatör panelinin sağ sütunu: durum, joystick ve görev listesi kartlarını bir araya getirir.
// CSS'te .control-panel overflow-y: auto ile kaydırılabilir — kartlar ekranı aşınca
// panel içi scroll (sayfa değil). Görev listesi max-height + iç scroll ile joystick'i aşağı itmez.
// Pin: sık kullanılan görevler scroll içinde kaybolmasın diye üstte tutulur;
// sıralama stabil (pinned önce, grup içi mevcut sıra) — her tıkta liste zıplamasın.
// PUT ile tasks.json'a yazılır; ayrı favori store yok (harita değişince pin kaybolmasın).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigation } from '../../context/NavigationContext';
import { INVALID_GOAL_MESSAGE } from '../../utils/mapPassability';
import { updateMapTask } from '../../utils/mapApi';
import Joystick from '../Joystick';
import StatusCard from './StatusCard';

/** Görev adım sayısını operatör dostu metne çevirir. */
function formatStepCount(steps) {
  const count = Array.isArray(steps) ? steps.length : 0;
  if (count === 0) return 'Adım yok';
  if (count === 1) return '1 adım';
  return `${count} adım`;
}

/** Görev adımlarında Toprağı Sür (till) eylemi var mı? */
function taskHasTillAction(task) {
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  return steps.some((step) => step?.action?.type === 'till');
}

/** Sabitlenenler önce; her grubun kendi sırası korunur (stable partition). */
function sortTasksByPinned(tasks) {
  const pinned = [];
  const rest = [];
  for (const task of tasks) {
    if (task.pinned) pinned.push(task);
    else rest.push(task);
  }
  return [...pinned, ...rest];
}

/**
 * Sağ kontrol paneli — harita yanında duran kartların kapsayıcısı.
 * Till onayı geofence'ten sonra sorulur: geçersiz hedefi önce elemek, operatörü gereksiz
 * "toprak sürme geri alınamaz" uyarısıyla yormamak için (geçersiz rota zaten başlamaz).
 */
export default function ControlPanel({
  activeMap,
  tasks,
  onTasksChange,
  tasksLoading,
  tasksError,
  mapReady,
  onValidateTask,
  onStartTask,
  lastSentGoal,
  queueBusy,
  showBusyPopup,
  onCloseBusyPopup,
  showInvalidGoalPopup,
  onCloseInvalidGoalPopup,
}) {
  const { previewTask, setPreviewTask } = useNavigation();
  const [tillConfirmTask, setTillConfirmTask] = useState(null);
  const [pinningId, setPinningId] = useState(null);
  // Çift tıklamada iki startTask üst üste binmesin
  const [startLocked, setStartLocked] = useState(false);
  const startCooldownRef = useRef(null);

  const sortedTasks = useMemo(() => sortTasksByPinned(tasks), [tasks]);

  useEffect(() => () => {
    if (startCooldownRef.current) {
      window.clearTimeout(startCooldownRef.current);
    }
  }, []);

  // Navigasyon aktifken önizleme kapalı kalsın (çift rota karışmasın)
  useEffect(() => {
    if (queueBusy) {
      setPreviewTask(null);
    }
  }, [queueBusy, setPreviewTask]);

  // Sıra bilinçli: geofence fail → invalid popup; geçince till varsa ikinci onay; yoksa direkt start
  const handleStartTask = (task) => {
    if (startLocked) return;
    setStartLocked(true);
    startCooldownRef.current = window.setTimeout(() => {
      setStartLocked(false);
      startCooldownRef.current = null;
    }, 1000);

    if (!onValidateTask(task)) return;

    if (taskHasTillAction(task)) {
      setTillConfirmTask(task);
      return;
    }

    onStartTask(task);
  };

  const handleTogglePreview = (task) => {
    if (queueBusy) return;
    setPreviewTask((prev) => (
      prev && prev.id === task.id ? null : task
    ));
  };

  const handleConfirmTillStart = () => {
    const task = tillConfirmTask;
    setTillConfirmTask(null);
    if (task) {
      onStartTask(task);
    }
  };

  const handleTogglePin = async (task) => {
    // İçerik aynı + pinned ters — backend PIN istemez; yalnızca sabitleme değişir
    if (!activeMap?.id || !task?.id || pinningId) return;

    const nextPinned = !task.pinned;
    const payload = {
      name: task.name,
      steps: task.steps,
      pinned: nextPinned,
    };
    if (typeof task.description === 'string' && task.description.trim()) {
      payload.description = task.description.trim();
    }

    setPinningId(task.id);
    try {
      const updated = await updateMapTask(activeMap.id, task.id, payload);
      onTasksChange?.(tasks.map((item) => (
        item.id === task.id ? { ...item, ...updated, pinned: nextPinned } : item
      )));
    } catch (err) {
      console.warn('[pin] görev sabitlenemedi:', err.message);
    } finally {
      setPinningId(null);
    }
  };

  return (
    <aside className="control-panel autonomous-panel" aria-label="Kontrol paneli">
      <StatusCard activeMap={activeMap} />

      <div className="panel-card panel-card--manual">
        <div className="panel-card__title">
          <span className="panel-card__icon">🕹️</span>
          Manuel Sürüş
        </div>
        <div className="manual-drive__joystick-wrap">
          <Joystick />
        </div>
      </div>

      <div className="panel-card panel-card--tasks">
        <div className="panel-card__title">
          <span className="panel-card__icon">🎯</span>
          Görevler
        </div>

        {tasksLoading && (
          <p className="autonomous-panel__meta">Görevler yükleniyor…</p>
        )}

        {!tasksLoading && tasksError && (
          <p className="autonomous-panel__meta autonomous-panel__meta--warn">{tasksError}</p>
        )}

        {!tasksLoading && !tasksError && tasks.length === 0 && (
          <p className="autonomous-panel__meta">Bu harita için tanımlı görev yok.</p>
        )}

        {!tasksLoading && !tasksError && sortedTasks.length > 0 && (
          <ul className="task-list">
            {sortedTasks.map((task) => {
              const stepCount = Array.isArray(task.steps) ? task.steps.length : 0;
              const canStart = mapReady && stepCount > 0 && !queueBusy;
              const isPinned = Boolean(task.pinned);
              const isPreview = Boolean(previewTask && previewTask.id === task.id);
              const canPreview = !queueBusy && stepCount > 0;

              return (
                <li
                  key={task.id || task.name}
                  className={[
                    'task-card',
                    isPinned ? 'task-card--pinned' : '',
                    isPreview ? 'task-card--preview' : '',
                    canPreview ? 'task-card--previewable' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => handleTogglePreview(task)}
                  role={canPreview ? 'button' : undefined}
                  tabIndex={canPreview ? 0 : undefined}
                  onKeyDown={(event) => {
                    if (!canPreview) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleTogglePreview(task);
                    }
                  }}
                  aria-pressed={canPreview ? isPreview : undefined}
                  title={canPreview ? (isPreview ? 'Rota önizlemesini kapat' : 'Rotayı haritada önizle') : undefined}
                >
                  <button
                    type="button"
                    className={`task-card__pin${isPinned ? ' task-card__pin--active' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleTogglePin(task);
                    }}
                    disabled={pinningId === task.id}
                    aria-label={isPinned ? 'Sabitlemeyi kaldır' : 'Görevi sabitle'}
                    aria-pressed={isPinned}
                    title={isPinned ? 'Sabitlemeyi kaldır' : 'Sabitle'}
                  >
                    📌
                  </button>
                  <div className="task-card__body">
                    <strong className="task-card__name">{task.name || 'Adsız görev'}</strong>
                    {task.description && (
                      <p className="task-card__description">{task.description}</p>
                    )}
                    <p className="autonomous-panel__meta">{formatStepCount(task.steps)}</p>
                  </div>
                  <button
                    type="button"
                    className={`autonomous-btn autonomous-btn--small${startLocked ? ' autonomous-btn--cooldown' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleStartTask(task);
                    }}
                    disabled={!canStart || startLocked}
                  >
                    Başlat
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {showBusyPopup && (
        <div className="queue-popup-backdrop" role="presentation">
          <div className="queue-popup" role="alertdialog" aria-labelledby="queue-popup-title">
            <h3 id="queue-popup-title">Navigasyon meşgul</h3>
            <p>
              Önceki hedef hâlâ işleniyor. Lütfen robot görevi tamamlayana kadar bekleyin
              veya kuyruk boşaldığında tekrar deneyin.
            </p>
            <button
              type="button"
              className="autonomous-btn"
              onClick={onCloseBusyPopup}
            >
              Tamam
            </button>
          </div>
        </div>
      )}

      {showInvalidGoalPopup && (
        <div className="queue-popup-backdrop" role="presentation">
          <div className="queue-popup" role="alertdialog" aria-labelledby="invalid-goal-popup-title">
            <h3 id="invalid-goal-popup-title">Geçersiz hedef</h3>
            <p>{INVALID_GOAL_MESSAGE}</p>
            <button
              type="button"
              className="autonomous-btn"
              onClick={onCloseInvalidGoalPopup}
            >
              Tamam
            </button>
          </div>
        </div>
      )}

      {tillConfirmTask && (
        <div className="queue-popup-backdrop" role="presentation">
          <div className="queue-popup" role="alertdialog" aria-labelledby="till-confirm-title">
            <h3 id="till-confirm-title">Toprak sürme uyarısı</h3>
            <p>
              Bu görev toprak sürme içeriyor ve geri alınamaz. Devam edilsin mi?
            </p>
            <div className="queue-popup__actions">
              <button
                type="button"
                className="autonomous-btn autonomous-btn--ghost"
                onClick={() => setTillConfirmTask(null)}
              >
                İptal
              </button>
              <button
                type="button"
                className="autonomous-btn"
                onClick={handleConfirmTillStart}
              >
                Devam
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
