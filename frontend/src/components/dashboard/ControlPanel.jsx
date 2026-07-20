// Operatör panelinin sağ sütunu: durum, görev listesi, joystick ve son olaylar kartlarını bir araya getirir.
// CSS'te .control-panel overflow-y: auto ile kaydırılabilir — kartlar ekranı aşınca
// "Son Olaylar" görünür alanın dışında kalmasın diye (sayfa değil, panel içi scroll).

import React from 'react';
import { INVALID_GOAL_MESSAGE } from '../../utils/mapPassability';
import Joystick from '../Joystick';
import RecentEventsPanel from './RecentEventsPanel';
import StatusCard from './StatusCard';

/** Görev adım sayısını operatör dostu metne çevirir. */
function formatStepCount(steps) {
  const count = Array.isArray(steps) ? steps.length : 0;
  if (count === 0) return 'Adım yok';
  if (count === 1) return '1 adım';
  return `${count} adım`;
}

/**
 * Sağ kontrol paneli — harita yanında duran kartların kapsayıcısı.
 * Geofence doğrulaması burada değil; Başlat tıklanınca DashboardPage.onStartTask çalışır.
 */
export default function ControlPanel({
  activeMap,
  tasks,
  tasksLoading,
  tasksError,
  mapReady,
  onStartTask,
  lastSentGoal,
  queueBusy,
  showBusyPopup,
  onCloseBusyPopup,
  showInvalidGoalPopup,
  onCloseInvalidGoalPopup,
}) {
  // Başlat → DashboardPage.onStartTask geofence sırası: 1) occupancy piksel 2) sınır poligonu 3) yasak dikdörtgen.
  // Harita engeli önce elenir; mühendis tanımlı kısıtlar en sonda uygulanır (isWorldGoalPassable).
  const handleStartTask = (task) => {
    onStartTask(task);
  };

  return (
    <aside className="control-panel autonomous-panel" aria-label="Kontrol paneli">
      <StatusCard activeMap={activeMap} />

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

        {!tasksLoading && !tasksError && tasks.length > 0 && (
          <ul className="task-list">
            {tasks.map((task) => {
              const stepCount = Array.isArray(task.steps) ? task.steps.length : 0;
              const canStart = mapReady && stepCount > 0 && !queueBusy;

              return (
                <li key={task.id || task.name} className="task-card">
                  <div className="task-card__body">
                    <strong className="task-card__name">{task.name || 'Adsız görev'}</strong>
                    <p className="autonomous-panel__meta">{formatStepCount(task.steps)}</p>
                  </div>
                  <button
                    type="button"
                    className="autonomous-btn autonomous-btn--small"
                    onClick={() => handleStartTask(task)}
                    disabled={!canStart}
                  >
                    Başlat
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="panel-card panel-card--manual">
        <div className="panel-card__title">
          <span className="panel-card__icon">🕹️</span>
          Manuel Sürüş
        </div>
        <div className="manual-drive__joystick-wrap">
          <Joystick />
        </div>
      </div>

      <div className="panel-card panel-card--events">
        <RecentEventsPanel />
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
    </aside>
  );
}
