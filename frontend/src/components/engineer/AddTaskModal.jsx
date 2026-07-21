// Mühendis paneli — görev oluşturma/düzenleme modal formu.
// Dinamik X/Y/Yaw adımları, opsiyonel açıklama ve görev bitince eylem seçimi içerir.

import React, { useEffect, useState } from 'react';
import { degreesToRadians } from '../../utils/rosNavigation';
import EngineerModal from './EngineerModal';

const FINAL_ACTION_OPTIONS = [
  { value: 'wait', label: 'Bekle' },
  { value: 'till', label: 'Toprağı Sür' },
  { value: 'goto_charge', label: 'Şarj İstasyonuna Git' },
  { value: 'goto_base', label: 'Base Konuma Git' },
];

function createEmptyStep() {
  return { x: '', y: '', yaw: '0' };
}

/** Radyan yaw'ı formda gösterilecek derece string'ine çevirir. */
function radiansToDegreesString(yaw) {
  if (typeof yaw !== 'number' || Number.isNaN(yaw)) {
    return '0';
  }
  return ((yaw * 180) / Math.PI).toFixed(1);
}

/** Adım satırını parse eder; geçersizse null döner. */
function parseStep(step) {
  const parsedX = parseFloat(step.x);
  const parsedY = parseFloat(step.y);
  const parsedYaw = parseFloat(step.yaw);
  if (Number.isNaN(parsedX) || Number.isNaN(parsedY) || Number.isNaN(parsedYaw)) {
    return null;
  }
  return {
    x: parsedX,
    y: parsedY,
    yaw: degreesToRadians(parsedYaw),
  };
}

/** Görev nesnesinden form state'ini üretir (edit modunda modal açılınca doldurulur). */
function taskToFormState(task) {
  if (!task) {
    return {
      name: '',
      description: '',
      steps: [createEmptyStep()],
      finalActionType: 'wait',
    };
  }

  const taskSteps = Array.isArray(task.steps) && task.steps.length > 0
    ? task.steps.map((step) => ({
      x: typeof step.x === 'number' ? String(step.x) : '',
      y: typeof step.y === 'number' ? String(step.y) : '',
      yaw: radiansToDegreesString(step.yaw),
    }))
    : [createEmptyStep()];

  return {
    name: task.name || '',
    description: task.description || '',
    steps: taskSteps,
    finalActionType: task.finalAction?.type || 'wait',
  };
}

/**
 * mode + initialTask: aynı modal hem ekleme hem düzenleme için — EngineerPage hangi API'yi
 * çağıracağını mode'a bakarak seçer (POST vs PUT).
 */
export default function AddTaskModal({
  open,
  onClose,
  onSave,
  saving,
  error,
  mode = 'create',
  initialTask = null,
}) {
  const isEditMode = mode === 'edit';
  const modalTitle = isEditMode ? 'Görevi Düzenle' : 'Görev Ekle';
  const modalTitleId = isEditMode ? 'edit-task-title' : 'add-task-title';

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Dinamik X/Y/Yaw satırları: konum listesine bağlı değil — serbest koordinat ve çok adımlı rota için
  const [steps, setSteps] = useState([createEmptyStep()]);
  const [finalActionType, setFinalActionType] = useState('wait');

  // Modal her açıldığında formu sıfırla veya initialTask'tan doldur (edit modu)
  useEffect(() => {
    if (!open) return;

    const formState = isEditMode
      ? taskToFormState(initialTask)
      : taskToFormState(null);

    setName(formState.name);
    setDescription(formState.description);
    setSteps(formState.steps);
    setFinalActionType(formState.finalActionType);
  }, [open, isEditMode, initialTask]);

  const updateStep = (index, field, value) => {
    setSteps((prev) => prev.map((step, i) => (
      i === index ? { ...step, [field]: value } : step
    )));
  };

  const removeStep = (index) => {
    setSteps((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== index);
    });
  };

  const addStep = () => {
    setSteps((prev) => [...prev, createEmptyStep()]);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;

    const parsedSteps = steps.map(parseStep).filter(Boolean);
    if (parsedSteps.length === 0) return;

    const payload = {
      name: name.trim(),
      steps: parsedSteps,
      finalAction: { type: finalActionType },
    };

    if (description.trim()) {
      payload.description = description.trim();
    }

    const saved = await onSave(payload, mode);
    if (saved && !isEditMode) {
      setName('');
      setDescription('');
      setSteps([createEmptyStep()]);
      setFinalActionType('wait');
    }
  };

  const hasValidSteps = steps.some((step) => parseStep(step) !== null);

  return (
    <EngineerModal open={open} onClose={onClose} wide tall ariaLabelledBy={modalTitleId}>
      <h3 id={modalTitleId}>{modalTitle}</h3>
      <form className="engineer-form engineer-form--task" onSubmit={handleSubmit}>
        <label className="engineer-form__field engineer-form__field--full">
          <span>Görev adı</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn. Sabah rutini"
            required
          />
        </label>

        <label className="engineer-form__field engineer-form__field--full">
          <span>Açıklama (opsiyonel)</span>
          <textarea
            className="engineer-form__textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Örn. Sabah rutini, sera boyunca ilerler"
            rows={2}
          />
        </label>

        <div className="engineer-form__field engineer-form__field--full">
          <span>Adımlar (X / Y / Yaw)</span>
          <ul className="engineer-task-steps">
            {steps.map((step, index) => (
              <li key={index} className="engineer-task-steps__row">
                <span className="engineer-task-steps__label">Adım {index + 1}</span>
                <label className="engineer-task-steps__input">
                  <span>X (m)</span>
                  <input
                    type="number"
                    step="0.01"
                    value={step.x}
                    onChange={(e) => updateStep(index, 'x', e.target.value)}
                    required
                  />
                </label>
                <label className="engineer-task-steps__input">
                  <span>Y (m)</span>
                  <input
                    type="number"
                    step="0.01"
                    value={step.y}
                    onChange={(e) => updateStep(index, 'y', e.target.value)}
                    required
                  />
                </label>
                <label className="engineer-task-steps__input">
                  <span>Yaw (°)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={step.yaw}
                    onChange={(e) => updateStep(index, 'yaw', e.target.value)}
                    required
                  />
                </label>
                <button
                  type="button"
                  className="autonomous-btn autonomous-btn--ghost autonomous-btn--small engineer-task-steps__remove"
                  onClick={() => removeStep(index)}
                  disabled={steps.length <= 1}
                  aria-label={`Adım ${index + 1} kaldır`}
                >
                  Kaldır
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="autonomous-btn autonomous-btn--ghost autonomous-btn--small engineer-task-steps__add"
            onClick={addStep}
          >
            + Adım Ekle
          </button>
        </div>

        <label className="engineer-form__field engineer-form__field--full">
          <span>Görev bitince</span>
          <select
            className="engineer-form__select"
            value={finalActionType}
            onChange={(e) => setFinalActionType(e.target.value)}
          >
            {FINAL_ACTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p className="engineer-form__error">{error}</p>
        )}

        <div className="engineer-form__actions">
          <button type="button" className="autonomous-btn autonomous-btn--ghost" onClick={onClose}>
            İptal
          </button>
          <button
            type="submit"
            className="autonomous-btn"
            disabled={saving || !hasValidSteps}
          >
            {saving ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
        </div>
      </form>
    </EngineerModal>
  );
}
