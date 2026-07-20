// Robot durum kartı: bağlantı, meşgul/hazır rozeti, görev ilerlemesi ve son hedef bilgisi.
// NavigationContext'ten okur; operatör ve mühendis panelinde ortak kullanılır.

import React from 'react';
import { useNavigation } from '../../context/NavigationContext';

/** Durum özeti kartı — büyük statusText ve kuyruk rozeti gösterir. */
export default function StatusCard({ activeMap, showMapName = true }) {
  const {
    statusText,
    activeTaskProgress,
    lastSentGoal,
    queueBusy,
    emergencyStopped,
  } = useNavigation();

  return (
    <div className="panel-card panel-card--status">
      <div className="panel-card__title">
        <span className="panel-card__icon">📊</span>
        Durum
      </div>
      {showMapName && activeMap && (
        <p className="control-panel__map-name">{activeMap.name}</p>
      )}
      <p className="control-panel__status-text">{statusText}</p>
      <div className={`queue-badge ${queueBusy && !emergencyStopped ? 'queue-badge--busy' : 'queue-badge--idle'}`}>
        {emergencyStopped
          ? 'Durduruldu'
          : queueBusy
            ? 'Meşgul — hedef işleniyor'
            : 'Hazır — yeni hedef kabul edilir'}
      </div>
      {activeTaskProgress && (
        <p className="autonomous-panel__meta">
          Görev ilerlemesi: {activeTaskProgress.currentStep}/{activeTaskProgress.totalSteps}
        </p>
      )}
      {lastSentGoal && (
        <div className="control-panel__last-goal">
          <span className="autonomous-panel__meta">Son gönderilen</span>
          <p className="autonomous-panel__target">
            X {lastSentGoal.x.toFixed(2)} m · Y {lastSentGoal.y.toFixed(2)} m
          </p>
          {lastSentGoal.source && (
            <p className="autonomous-panel__meta">Kaynak: {lastSentGoal.source}</p>
          )}
        </div>
      )}
    </div>
  );
}
