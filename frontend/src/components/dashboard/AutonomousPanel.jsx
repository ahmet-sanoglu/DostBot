import React, { useEffect, useRef, useState } from 'react';
import { useTelemetry } from '../../context/TelemetryContext';
import {
  degreesToRadians,
  normalizeAngle,
} from '../../utils/rosNavigation';

const PRESETS_STORAGE_KEY = 'agrifleet_presets';

function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePresets(presets) {
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
}

function formatTarget(target) {
  if (!target) return '—';
  const yawDeg = ((normalizeAngle(target.yaw ?? 0) * 180) / Math.PI).toFixed(1);
  return `X ${target.x.toFixed(2)} m · Y ${target.y.toFixed(2)} m · Yaw ${yawDeg}°`;
}

export default function AutonomousPanel({
  draftGoal,
  onSendGoal,
  lastSentGoal,
  queueBusy,
  showBusyPopup,
  onCloseBusyPopup,
}) {
  const { pose } = useTelemetry();
  const [presets, setPresets] = useState(loadPresets);
  const [presetName, setPresetName] = useState('');
  const [manualX, setManualX] = useState('');
  const [manualY, setManualY] = useState('');
  const [manualYaw, setManualYaw] = useState('');
  const manualFormInitialized = useRef(false);

  useEffect(() => {
    if (!pose || manualFormInitialized.current) return;
    manualFormInitialized.current = true;
    setManualX(pose.x.toFixed(2));
    setManualY(pose.y.toFixed(2));
    setManualYaw(((normalizeAngle(pose.yaw) * 180) / Math.PI).toFixed(1));
  }, [pose]);

  const handleManualSubmit = (e) => {
    e.preventDefault();
    const x = parseFloat(manualX);
    const y = parseFloat(manualY);
    const yaw = degreesToRadians(parseFloat(manualYaw));
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(yaw)) return;

    onSendGoal({ x, y, yaw }, 'Manuel giriş');
  };

  const persistPresets = (updater) => {
    setPresets((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      savePresets(next);
      return next;
    });
  };

  const handleSavePresetFromForm = () => {
    const x = parseFloat(manualX);
    const y = parseFloat(manualY);
    const yaw = degreesToRadians(parseFloat(manualYaw));
    const name = presetName.trim();
    if (!name || Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(yaw)) return;

    persistPresets((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name,
        x,
        y,
        yaw,
      },
    ]);
    setPresetName('');
  };

  const handleDeletePreset = (id) => {
    persistPresets((prev) => prev.filter((item) => item.id !== id));
  };

  const handleUseDraft = () => {
    if (!draftGoal) return;
    onSendGoal(draftGoal, 'Harita tıklama');
  };

  return (
    <aside className="autonomous-panel" aria-label="Otonom görev paneli">
      <div className="panel-card">
        <div className="panel-card__title">
          <span className="panel-card__icon">🎯</span>
          Son Gönderilen Hedef
        </div>
        <p className="autonomous-panel__target">{formatTarget(lastSentGoal)}</p>
        {lastSentGoal?.source && (
          <p className="autonomous-panel__meta">Kaynak: {lastSentGoal.source}</p>
        )}
      </div>

      <div className="panel-card">
        <div className="panel-card__title">
          <span className="panel-card__icon">📌</span>
          Kuyruk Durumu
        </div>
        <div className={`queue-badge ${queueBusy ? 'queue-badge--busy' : 'queue-badge--idle'}`}>
          {queueBusy ? 'Meşgul — hedef işleniyor' : 'Hazır — yeni hedef kabul edilir'}
        </div>
        {draftGoal && (
          <div className="autonomous-panel__draft">
            <span className="autonomous-panel__meta">Seçili hedef</span>
            <p className="autonomous-panel__target">{formatTarget(draftGoal)}</p>
            <button type="button" className="autonomous-btn" onClick={handleUseDraft}>
              Hedefi Gönder
            </button>
          </div>
        )}
      </div>

      <div className="panel-card">
        <div className="panel-card__title">
          <span className="panel-card__icon">⌨️</span>
          Manuel X / Y / Yaw
        </div>
        <form className="autonomous-form" onSubmit={handleManualSubmit}>
          <label className="autonomous-form__field">
            <span>X (m)</span>
            <input
              type="number"
              step="0.01"
              value={manualX}
              onChange={(e) => setManualX(e.target.value)}
            />
          </label>
          <label className="autonomous-form__field">
            <span>Y (m)</span>
            <input
              type="number"
              step="0.01"
              value={manualY}
              onChange={(e) => setManualY(e.target.value)}
            />
          </label>
          <label className="autonomous-form__field">
            <span>Yaw (°)</span>
            <input
              type="number"
              step="0.1"
              value={manualYaw}
              onChange={(e) => setManualYaw(e.target.value)}
            />
          </label>
          <button type="submit" className="autonomous-btn">Gönder</button>
        </form>

        <div className="preset-save-inline">
          <label className="autonomous-form__field autonomous-form__field--full">
            <span>Preset adı</span>
            <input
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="Örn. Sera Girişi"
            />
          </label>
          <button
            type="button"
            className="autonomous-btn autonomous-btn--ghost"
            onClick={handleSavePresetFromForm}
          >
            Hazır Konum Olarak Kaydet
          </button>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-card__title">
          <span className="panel-card__icon">📍</span>
          Hazır Konumlar
        </div>

        {presets.length === 0 ? (
          <p className="autonomous-panel__meta">Henüz kayıtlı konum yok.</p>
        ) : (
          <ul className="preset-list">
            {presets.map((preset) => (
              <li key={preset.id} className="preset-list__item">
                <div>
                  <strong>{preset.name}</strong>
                  <p className="autonomous-panel__meta">
                    {formatTarget(preset)}
                  </p>
                </div>
                <div className="preset-list__actions">
                  <button
                    type="button"
                    className="autonomous-btn autonomous-btn--small"
                    onClick={() => onSendGoal(preset, `Preset: ${preset.name}`)}
                  >
                    Git
                  </button>
                  <button
                    type="button"
                    className="autonomous-btn autonomous-btn--ghost autonomous-btn--small"
                    onClick={() => handleDeletePreset(preset.id)}
                  >
                    Sil
                  </button>
                </div>
              </li>
            ))}
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
    </aside>
  );
}
