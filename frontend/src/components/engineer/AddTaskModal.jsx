// Mühendis paneli — görev oluşturma/düzenleme modal formu.
// Her noktanın kendi dropdown'ı vardır: aynı rotada A'da sürüm, B'de bekleme gibi
// çoklu tarla/çoklu eylem senaryoları tek görevde tanımlanabilsin diye (tek finalAction yetmez).
// İki panel: sol form (elle X/Y/Yaw/eylem) + sağ TaskRouteMap — haritadan ekleme alternatifidir,
// form davranışını değiştirmez; tek steps state ile anında senkron kalırlar.
// extraWide + sabit 85vh (App.css): adım eklenince modal büyümesin, liste iç scroll yapsın.
// Sürükle-bırak sıra: harita numaraları aynı state'ten geldiği için ekstra senkron yok.
// Mesafe/süre: düz çizgi toplamı + 0.15 m/s — dönüş/engel yok, yalnızca kaba önizleme.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { degreesToRadians } from '../../utils/rosNavigation';
import EngineerModal from './EngineerModal';
import TaskRouteMap from './TaskRouteMap';

const STEP_ACTION_OPTIONS = [
  { value: 'wait', label: 'Bekle' },
  { value: 'till', label: 'Toprağı Sür' },
  { value: 'goto_charge', label: 'Şarj İstasyonuna Git' },
  { value: 'goto_base', label: 'Base Konuma Git' },
];

/** TurtleBot3 dönüşler dahil gerçekçi ortalama — Nav2 anlık hızı değil. */
const ESTIMATE_SPEED_MPS = 0.15;

function createEmptyStep() {
  // actionType form state'i; kayıtta backend step.action: {type} olarak gider
  // _dragId yalnızca DnD/FLIP için; kayda gitmez
  return { x: '', y: '', yaw: '0', actionType: 'wait', _dragId: crypto.randomUUID() };
}

function ensureDragId(step) {
  if (step?._dragId) return step;
  return { ...step, _dragId: crypto.randomUUID() };
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
    action: { type: step.actionType || 'wait' },
  };
}

/** Geçerli X/Y noktaları — boş form satırları mesafe hesabına girmez. */
function getValidWorldPoints(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((step) => ({
      x: typeof step.x === 'number' ? step.x : parseFloat(step.x),
      y: typeof step.y === 'number' ? step.y : parseFloat(step.y),
    }))
    .filter((point) => !Number.isNaN(point.x) && !Number.isNaN(point.y));
}

/** Ardışık noktalar arası düz çizgi toplamı (metre). */
function calculateTotalDistance(steps) {
  const points = getValidWorldPoints(steps);
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

/** "X.X m · ~Y dk Z sn (yaklaşık)" — 2+ nokta yoksa null. */
function formatRouteEstimate(steps) {
  const points = getValidWorldPoints(steps);
  if (points.length < 2) return null;

  const distance = calculateTotalDistance(steps);
  const totalSeconds = distance / ESTIMATE_SPEED_MPS;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);

  const timeText = minutes > 0
    ? `~${minutes} dk ${seconds} sn`
    : `~${seconds} sn`;

  return `Tahmini mesafe: ${distance.toFixed(1)} m · Tahmini süre: ${timeText} (yaklaşık)`;
}

function reorderStepsWithEdge(list, fromIndex, toIndex, edge) {
  if (fromIndex < 0 || fromIndex >= list.length) return list;
  if (toIndex < 0 || toIndex >= list.length) return list;

  let insertAt = edge === 'after' ? toIndex + 1 : toIndex;
  const next = list.slice();
  const [moved] = next.splice(fromIndex, 1);
  if (fromIndex < insertAt) insertAt -= 1;
  insertAt = Math.max(0, Math.min(insertAt, next.length));
  next.splice(insertAt, 0, moved);
  return next;
}

/** Görev nesnesinden form state'ini üretir (edit modunda modal açılınca doldurulur). */
function taskToFormState(task) {
  if (!task) {
    return {
      name: '',
      description: '',
      steps: [createEmptyStep()],
    };
  }

  const taskSteps = Array.isArray(task.steps) && task.steps.length > 0
    ? task.steps.map((step) => ({
      x: typeof step.x === 'number' ? String(step.x) : '',
      y: typeof step.y === 'number' ? String(step.y) : '',
      yaw: radiansToDegreesString(step.yaw),
      actionType: step.action?.type || task.finalAction?.type || 'wait',
      _dragId: crypto.randomUUID(),
    }))
    : [createEmptyStep()];

  return {
    name: task.name || '',
    description: task.description || '',
    steps: taskSteps,
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
  // Her eleman {x, y, yaw, actionType} — eylem nokta bazlı; tek görev-sonu dropdown kaldırıldı
  const [steps, setSteps] = useState([createEmptyStep()]);
  const [nameError, setNameError] = useState('');
  const [stepsError, setStepsError] = useState('');
  const [draggingIndex, setDraggingIndex] = useState(null);
  const [dropHint, setDropHint] = useState(null); // { index, edge: 'before'|'after' }
  const dragFromIndexRef = useRef(null);
  const listRef = useRef(null);
  const flipRectsRef = useRef(null);

  const routeEstimateText = useMemo(() => formatRouteEstimate(steps), [steps]);

  const snapshotFlipRects = () => {
    const list = listRef.current;
    if (!list) return;
    const map = new Map();
    list.querySelectorAll('[data-drag-id]').forEach((el) => {
      map.set(el.getAttribute('data-drag-id'), el.getBoundingClientRect());
    });
    flipRectsRef.current = map;
  };

  useLayoutEffect(() => {
    const prev = flipRectsRef.current;
    const list = listRef.current;
    if (!prev || !list) return;

    list.querySelectorAll('[data-drag-id]').forEach((el) => {
      const id = el.getAttribute('data-drag-id');
      const first = prev.get(id);
      if (!first) return;
      const last = el.getBoundingClientRect();
      const dy = first.top - last.top;
      if (Math.abs(dy) < 0.5) return;

      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      void el.offsetHeight;
      el.style.transition = 'transform 0.15s ease';
      el.style.transform = '';

      const onEnd = (event) => {
        if (event.propertyName !== 'transform') return;
        el.style.transition = '';
        el.removeEventListener('transitionend', onEnd);
      };
      el.addEventListener('transitionend', onEnd);
    });

    flipRectsRef.current = null;
  }, [steps]);

  useEffect(() => {
    if (!open) return undefined;

    const formState = isEditMode
      ? taskToFormState(initialTask)
      : taskToFormState(null);

    setName(formState.name);
    setDescription(formState.description);
    setSteps(formState.steps);
    setNameError('');
    setStepsError('');
    setDraggingIndex(null);
    setDropHint(null);
    dragFromIndexRef.current = null;
    document.body.classList.remove('engineer-task-dragging');

    return () => {
      document.body.classList.remove('engineer-task-dragging');
    };
  }, [open, isEditMode, initialTask]);

  const updateStep = (index, field, value) => {
    setStepsError('');
    setSteps((prev) => prev.map((step, i) => (
      i === index ? { ...step, [field]: value } : step
    )));
  };

  const removeStep = (index) => {
    setStepsError('');
    setSteps((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== index);
    });
  };

  const addStep = () => {
    setStepsError('');
    setSteps((prev) => [...prev, createEmptyStep()]);
  };

  const handleStepsChange = (nextSteps) => {
    setStepsError('');
    setSteps(nextSteps.map(ensureDragId));
  };

  const clearDragUi = () => {
    dragFromIndexRef.current = null;
    setDraggingIndex(null);
    setDropHint(null);
    document.body.classList.remove('engineer-task-dragging');
  };

  const handleDragStart = (index, event) => {
    dragFromIndexRef.current = index;
    setDraggingIndex(index);
    setDropHint(null);
    document.body.classList.add('engineer-task-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
    // Bazı tarayıcılarda drag görüntüsü tutamacı alır; satırı işaretlemek için class state yeterli
  };

  const handleDragOver = (index, event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dragFromIndexRef.current === index) {
      setDropHint(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDropHint((prev) => (
      prev && prev.index === index && prev.edge === edge
        ? prev
        : { index, edge }
    ));
  };

  const handleDragLeave = (index, event) => {
    // Çocuk elemana geçince leave tetiklenir — relatedTarget hâlâ satırdaysa yok say
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDropHint((prev) => (prev?.index === index ? null : prev));
  };

  const handleDrop = (toIndex, event) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('text/plain');
    const fromIndex = dragFromIndexRef.current ?? parseInt(raw, 10);
    const edge = dropHint?.index === toIndex ? dropHint.edge : (
      event.clientY < event.currentTarget.getBoundingClientRect().top
        + event.currentTarget.getBoundingClientRect().height / 2
        ? 'before'
        : 'after'
    );

    if (Number.isNaN(fromIndex)) {
      clearDragUi();
      return;
    }

    snapshotFlipRects();
    setStepsError('');
    setSteps((prev) => reorderStepsWithEdge(prev, fromIndex, toIndex, edge));
    clearDragUi();
  };

  const handleDragEnd = () => {
    clearDragUi();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const trimmedName = name.trim();
    const parsedSteps = steps.map(parseStep).filter(Boolean);
    let hasError = false;

    if (!trimmedName) {
      setNameError('Görev adı gerekli');
      hasError = true;
    } else {
      setNameError('');
    }

    // Boş satır sayılmaz — en az bir geçerli X/Y/Yaw noktası şart
    if (parsedSteps.length === 0 || steps.length === 0) {
      setStepsError('En az bir nokta eklemelisiniz');
      hasError = true;
    } else {
      setStepsError('');
    }

    if (hasError) return;

    const payload = {
      name: trimmedName,
      steps: parsedSteps,
    };

    if (description.trim()) {
      payload.description = description.trim();
    }

    const saved = await onSave(payload, mode);
    if (saved && !isEditMode) {
      setName('');
      setDescription('');
      setSteps([createEmptyStep()]);
      setNameError('');
      setStepsError('');
    }
  };

  return (
    <EngineerModal
      open={open}
      onClose={onClose}
      wide
      tall
      extraWide
      ariaLabelledBy={modalTitleId}
    >
      <h3 id={modalTitleId}>{modalTitle}</h3>
      {/* Sol form | sağ harita — CSS grid; adım rozeti harita numarasıyla eşleşsin diye index+1 */}
      <div className="engineer-task-modal">
        <form className="engineer-form engineer-form--task" onSubmit={handleSubmit}>
          <label className="engineer-form__field engineer-form__field--full">
            <span>Görev adı</span>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError('');
              }}
              placeholder="Örn. Sabah rutini"
            />
            {nameError && (
              <p className="engineer-form__field-error">{nameError}</p>
            )}
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

          <div className="engineer-form__field engineer-form__field--full engineer-form__field--steps">
            <span>Noktalar</span>
            <ul className="engineer-task-steps" ref={listRef}>
              {steps.map((step, index) => {
                const dragId = step._dragId || `step-${index}`;
                const isDragging = draggingIndex === index;
                const hint = dropHint?.index === index ? dropHint.edge : null;
                const blockClass = [
                  'engineer-task-steps__block',
                  isDragging ? 'engineer-task-steps__block--dragging' : '',
                  hint === 'before' ? 'engineer-task-steps__block--drop-before' : '',
                  hint === 'after' ? 'engineer-task-steps__block--drop-after' : '',
                ].filter(Boolean).join(' ');

                return (
                  <li
                    key={dragId}
                    data-drag-id={dragId}
                    className={blockClass}
                    onDragOver={(event) => handleDragOver(index, event)}
                    onDragLeave={(event) => handleDragLeave(index, event)}
                    onDrop={(event) => handleDrop(index, event)}
                  >
                    <div className="engineer-task-steps__row">
                      <span
                        className="engineer-task-steps__drag"
                        draggable
                        onDragStart={(event) => handleDragStart(index, event)}
                        onDragEnd={handleDragEnd}
                        title="Sürükleyerek sırayı değiştir"
                        aria-label={`Nokta ${index + 1} sırasını değiştir`}
                      >
                        ⠿
                      </span>
                      <span className="engineer-task-steps__badge" aria-hidden="true">
                        {index + 1}
                      </span>
                      <span className="engineer-task-steps__label">Nokta {index + 1}</span>
                      <label className="engineer-task-steps__input">
                        <span>X (m)</span>
                        <input
                          type="number"
                          step="0.01"
                          value={step.x}
                          onChange={(e) => updateStep(index, 'x', e.target.value)}
                        />
                      </label>
                      <label className="engineer-task-steps__input">
                        <span>Y (m)</span>
                        <input
                          type="number"
                          step="0.01"
                          value={step.y}
                          onChange={(e) => updateStep(index, 'y', e.target.value)}
                        />
                      </label>
                      <label className="engineer-task-steps__input">
                        <span>Yaw (°)</span>
                        <input
                          type="number"
                          step="0.1"
                          value={step.yaw}
                          onChange={(e) => updateStep(index, 'yaw', e.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className="autonomous-btn autonomous-btn--ghost autonomous-btn--small engineer-task-steps__remove"
                        onClick={() => removeStep(index)}
                        disabled={steps.length <= 1}
                        aria-label={`Nokta ${index + 1} kaldır`}
                      >
                        Kaldır
                      </button>
                    </div>
                    {/* Nokta bazlı eylem — NavigationContext bu step'e varınca seçilen türü çalıştırır */}
                    <label className="engineer-task-steps__action">
                      <span>Bu noktada ne yapılsın</span>
                      <select
                        className="engineer-form__select"
                        value={step.actionType}
                        onChange={(e) => updateStep(index, 'actionType', e.target.value)}
                      >
                        {STEP_ACTION_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </li>
                );
              })}
            </ul>
            {stepsError && (
              <p className="engineer-form__field-error">{stepsError}</p>
            )}
            <button
              type="button"
              className="autonomous-btn autonomous-btn--ghost autonomous-btn--small engineer-task-steps__add"
              onClick={addStep}
            >
              + Yeni Nokta Ekle
            </button>
          </div>

          {routeEstimateText && (
            <p className="engineer-form__estimate">{routeEstimateText}</p>
          )}

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
              disabled={saving}
            >
              {saving ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          </div>
        </form>

        <TaskRouteMap steps={steps} onStepsChange={handleStepsChange} />
      </div>
    </EngineerModal>
  );
}
