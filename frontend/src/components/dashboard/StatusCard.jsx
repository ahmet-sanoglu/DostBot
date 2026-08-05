// Robot durum kartı: bağlantı, meşgul/hazır rozeti, görev ilerlemesi ve son hedef bilgisi.
// NavigationContext'ten okur — yalnızca Kontrol Paneli'nde gösterilir (Mühendis'te ayrı
// örnek açılınca state paylaşılmadığı için orada kart yok; canlı durum tek yerde kalsın).

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
    recoveryCount,
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
            ? (
              <>
                Meşgul — hedef işleniyor
                {/* ≥2 recoveries: Nav2 zorlanıyor; görev iptal değil, yalnızca uyarı rozeti */}
                {recoveryCount >= 2 && (
                  <span className="queue-badge__recovery"> ⚠️ Zorlanıyor</span>
                )}
              </>
            )
            : 'Hazır — yeni hedef kabul edilir'}
      </div>
      {activeTaskProgress && (
        <p className="autonomous-panel__meta">
          {/* stepActionLabel: till vb. sürerken operatör hangi adımda hangi eylemde olduğunu görür */}
          Görev ilerlemesi: Adım {activeTaskProgress.currentStep}/{activeTaskProgress.totalSteps}
          {activeTaskProgress.stepActionLabel && (
            <> — {activeTaskProgress.stepActionLabel}</>
          )}
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
