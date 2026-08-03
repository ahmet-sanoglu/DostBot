// Görev Geçmişi — 3 sütunlu Kanban (Devam canlı nav state; Tamamlandı/İptal backend).
// Devam Ediyor: NavigationContext (+ yeni sekme için BroadcastChannel), backend "devam ediyor" yok.
// Bitiş: terminal POST sonrası broadcast → bu sayfa GET yeniler (elle Yenile gerekmez).
// Backend run_id birleştirmesi: tamamlanan görevler "yarım kaldı" görünmesin diye.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigation } from '../context/NavigationContext';
import { fetchActiveMap, fetchMapTaskHistory } from '../utils/mapApi';
import {
  readNavSnapshot,
  subscribeNavigationBroadcast,
} from '../utils/navigationBroadcast';

const STATUS_LABEL = {
  başarılı: 'Başarılı',
  başarısız: 'Başarısız',
  'iptal edildi': 'İptal Edildi',
  'devam ediyor': 'Devam Ediyor',
  'yarım kaldı': 'Yarım Kaldı',
};

const STATUS_CARD_CLASS = {
  başarılı: 'task-history-card--success',
  başarısız: 'task-history-card--warn',
  'iptal edildi': 'task-history-card--cancel',
  'devam ediyor': 'task-history-card--running',
  'yarım kaldı': 'task-history-card--stale',
};

const STATUS_BADGE_CLASS = {
  başarılı: 'task-history-badge--success',
  başarısız: 'task-history-badge--warn',
  'iptal edildi': 'task-history-badge--fail',
  'devam ediyor': 'task-history-badge--started',
  'yarım kaldı': 'task-history-badge--stale',
};

/** ISO → HH:MM. */
function formatStartTime(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return String(timestamp);
  return date.toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Koordinat metni: "1.23, 4.56 konumuna". */
function formatCoords(x, y) {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return `${x.toFixed(2)}, ${y.toFixed(2)} konumuna`;
}

/** Gün anahtarı YYYY-MM-DD (yerel). */
function dayKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayKey() {
  return dayKey(Date.now());
}

function formatDayHeading(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Bilinmeyen gün';
  const raw = date.toLocaleDateString('tr-TR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function formatDayOption(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '?';
  return date.toLocaleDateString('tr-TR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function groupRunsByDay(runs) {
  const groups = [];
  const indexByKey = new Map();

  for (const run of runs) {
    const key = dayKey(run.startedAt);
    let group = indexByKey.get(key);
    if (!group) {
      group = {
        key,
        label: formatDayHeading(run.startedAt),
        optionLabel: formatDayOption(run.startedAt),
        runs: [],
      };
      indexByKey.set(key, group);
      groups.push(group);
    }
    group.runs.push(run);
  }

  return groups;
}

/**
 * Kart: ad → konum·saat → durum rozeti + açıklama (saat tekrarı yok).
 * @param {{ taskName?: string, startedAt?: string, finalStatus?: string, x?: number, y?: number }} run
 */
function RunCard({ run }) {
  const status = run.finalStatus || '';
  const cardClass = STATUS_CARD_CLASS[status] || 'task-history-card--running';
  const badgeClass = STATUS_BADGE_CLASS[status] || 'task-history-badge--started';
  const label = STATUS_LABEL[status] || status || '—';
  const time = formatStartTime(run.startedAt);
  const coords = formatCoords(run.x, run.y);
  const locationLine = coords ? `${coords} · ${time}` : time;
  // Durum satırı: rozet + kısa açıklama (tarih/saat yok — üst satırda)
  const detail = status === 'yarım kaldı' ? 'Sonuç alınamadı' : null;

  return (
    <article className={`task-history-card ${cardClass}`}>
      <h3 className="task-history-card__name">{run.taskName || '—'}</h3>
      <time className="task-history-card__location" dateTime={run.startedAt || undefined}>
        {locationLine}
      </time>
      <p className="task-history-card__status">
        <span className={`task-history-badge ${badgeClass}`}>{label}</span>
        {detail ? (
          <span className="task-history-card__detail">{detail}</span>
        ) : null}
      </p>
    </article>
  );
}

function DaySelect({ days, selectedKey, onChange, ariaLabel }) {
  const today = todayKey();
  const hasToday = days.some((day) => day.key === today);
  const todayOptionLabel = formatDayOption(Date.now());

  return (
    <label className="task-history-day-select">
      <span className="visually-hidden">{ariaLabel}</span>
      <select
        value={selectedKey}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
      >
        <option value="all">Tüm günler</option>
        {!hasToday && (
          <option value={today}>{todayOptionLabel}</option>
        )}
        {days.map((day) => (
          <option key={day.key} value={day.key}>
            {day.optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function KanbanColumn({
  title,
  emoji,
  dot,
  count,
  emptyText,
  runs,
  groupByDay = false,
  showDayFilter = false,
  dayFilterKey = 'all',
  onDayFilterChange,
}) {
  const allGroups = useMemo(
    () => (groupByDay ? groupRunsByDay(runs) : []),
    [groupByDay, runs],
  );

  const visibleGroups = useMemo(() => {
    if (!groupByDay) return [];
    if (!showDayFilter || dayFilterKey === 'all') return allGroups;
    return allGroups.filter((g) => g.key === dayFilterKey);
  }, [allGroups, dayFilterKey, groupByDay, showDayFilter]);

  useEffect(() => {
    if (!showDayFilter || !onDayFilterChange) return;
    if (dayFilterKey === 'all' || dayFilterKey === todayKey()) return;
    if (!allGroups.some((g) => g.key === dayFilterKey)) {
      onDayFilterChange(todayKey());
    }
  }, [allGroups, dayFilterKey, onDayFilterChange, showDayFilter]);

  return (
    <section className={`task-history-column task-history-column--${dot}`}>
      <header className="task-history-column__header">
        <div className="task-history-column__title-row">
          <span className={`task-history-column__dot task-history-column__dot--${dot}`} aria-hidden="true" />
          <h2 className="task-history-column__title">
            <span aria-hidden="true">{emoji}</span>
            <span>{title}</span>
          </h2>
          <span className="task-history-column__count">({count})</span>
        </div>
        {showDayFilter && (
          <DaySelect
            days={allGroups}
            selectedKey={dayFilterKey}
            onChange={onDayFilterChange}
            ariaLabel={`${title} gün filtresi`}
          />
        )}
      </header>

      <div className="task-history-column__body">
        {runs.length === 0 && (
          <p className="task-history-empty task-history-empty--section">{emptyText}</p>
        )}

        {!groupByDay && runs.length > 0 && (
          <div className="task-history-column__cards">
            {runs.map((run, index) => (
              <RunCard
                key={`flat-${run.startedAt}-${run.taskName}-${index}`}
                run={run}
              />
            ))}
          </div>
        )}

        {groupByDay && runs.length > 0 && visibleGroups.length === 0 && (
          <p className="task-history-empty task-history-empty--section">Bu güne ait kayıt yok.</p>
        )}

        {groupByDay && visibleGroups.length > 0 && (
          <div className="task-history-column__days">
            {visibleGroups.map((group) => (
              <div key={group.key} className="task-history-day">
                <h3 className="task-history-day__heading">{group.label}</h3>
                <div className="task-history-column__cards">
                  {group.runs.map((run, index) => (
                    <RunCard
                      key={`${group.key}-${run.startedAt}-${run.taskName}-${index}`}
                      run={run}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Canlı nav snapshot → tek "devam ediyor" run (veya null). */
function buildLiveRunningRun(snapshot) {
  if (!snapshot?.queueBusy) return null;

  const progress = snapshot.activeTaskProgress;
  if (progress) {
    const stepIndex = Math.max(0, (progress.currentStep || 1) - 1);
    const step = Array.isArray(progress.steps) ? progress.steps[stepIndex] : null;
    return {
      taskName: progress.taskName || 'Görev',
      startedAt: progress.startedAt || snapshot.navStartedAt || new Date().toISOString(),
      finalStatus: 'devam ediyor',
      x: typeof step?.x === 'number' ? step.x : undefined,
      y: typeof step?.y === 'number' ? step.y : undefined,
    };
  }

  const goal = snapshot.lastSentGoal;
  if (goal && typeof goal.x === 'number' && typeof goal.y === 'number') {
    return {
      taskName: goal.source || 'Navigasyon',
      startedAt: snapshot.navStartedAt || new Date().toISOString(),
      finalStatus: 'devam ediyor',
      x: goal.x,
      y: goal.y,
    };
  }

  return null;
}

/** Görev Geçmişi (/gorev-gecmisi) — 3 sütunlu Kanban. */
export default function TaskHistoryPage() {
  const nav = useNavigation();
  const [mapName, setMapName] = useState('');
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [completedDayKey, setCompletedDayKey] = useState(todayKey);
  const [cancelledDayKey, setCancelledDayKey] = useState(todayKey);
  // Yeni sekme: kontrol panelinden BroadcastChannel/localStorage snapshot
  const [remoteSnapshot, setRemoteSnapshot] = useState(() => readNavSnapshot());

  const loadHistory = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const map = await fetchActiveMap();
      const history = await fetchMapTaskHistory(map.id);
      setMapName(map.name || map.id);
      // Backend "devam ediyor" UI canlı sütununa taşınmaz — sadece bitmişler
      const list = Array.isArray(history) ? history : [];
      setRuns(list.filter((r) => r.finalStatus !== 'devam ediyor'));
    } catch (err) {
      if (!silent) {
        setRuns([]);
        setError(err.message || 'Görev geçmişi yüklenemedi.');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Kontrol paneli sekmesinden canlı görev + terminal POST / idle sonrası yenileme
  useEffect(() => {
    return subscribeNavigationBroadcast((msg) => {
      if (msg.type === 'nav-snapshot') {
        setRemoteSnapshot(msg.snapshot || null);
      }
      if (msg.type === 'task-history-updated') {
        void loadHistory({ silent: true });
      }
    });
  }, [loadHistory]);

  // Aynı sekmede (nadir) local NavigationContext öncelikli
  const liveSnapshot = useMemo(() => {
    const localBusy = Boolean(nav.queueBusy);
    const localProgress = nav.activeTaskProgress;
    if (localBusy || localProgress) {
      return {
        queueBusy: localBusy,
        activeTaskProgress: localProgress,
        lastSentGoal: nav.lastSentGoal,
        navStartedAt: localProgress?.startedAt || null,
      };
    }
    return remoteSnapshot;
  }, [nav.queueBusy, nav.activeTaskProgress, nav.lastSentGoal, remoteSnapshot]);

  // queueBusy true→false: görev bitti → backend'den geçmişi yeniden çek
  // (yeni sekme: remote snapshot; aynı sekme: local nav — POST gecikmesi için kısa bekleme)
  const wasLiveBusyRef = useRef(false);
  useEffect(() => {
    const busy = Boolean(liveSnapshot?.queueBusy);
    if (wasLiveBusyRef.current && !busy) {
      const timer = window.setTimeout(() => {
        void loadHistory({ silent: true });
      }, 500);
      wasLiveBusyRef.current = false;
      return () => window.clearTimeout(timer);
    }
    if (busy) {
      wasLiveBusyRef.current = true;
    }
    return undefined;
  }, [liveSnapshot?.queueBusy, loadHistory]);

  const runningRuns = useMemo(() => {
    const live = buildLiveRunningRun(liveSnapshot);
    return live ? [live] : [];
  }, [liveSnapshot]);

  const completedRuns = useMemo(
    () => runs.filter((r) => (
      r.finalStatus === 'başarılı'
      || r.finalStatus === 'başarısız'
      || r.finalStatus === 'yarım kaldı'
    )),
    [runs],
  );
  const cancelledRuns = useMemo(
    () => runs.filter((r) => r.finalStatus === 'iptal edildi'),
    [runs],
  );

  return (
    <div className="task-history-page">
      <header className="task-history-page__header">
        <div className="task-history-page__title-row">
          <h1 className="task-history-page__title">
            <span aria-hidden="true">📋</span>
            <span>Görev Geçmişi</span>
          </h1>
          {mapName ? (
            <span className="task-history-page__map">{mapName}</span>
          ) : null}
          <button
            type="button"
            className="task-history-page__refresh"
            onClick={() => loadHistory()}
            disabled={loading}
          >
            Yenile
          </button>
        </div>
      </header>

      {loading && <p className="task-history-empty">Yükleniyor…</p>}
      {!loading && error && <p className="task-history-error">{error}</p>}

      {!loading && !error && (
        <div className="task-history-board">
          <KanbanColumn
            title="Devam Ediyor"
            emoji="⏱️"
            dot="running"
            count={runningRuns.length}
            emptyText="Şu an çalışan görev yok."
            runs={runningRuns}
          />
          <KanbanColumn
            title="Tamamlandı"
            emoji="✅"
            dot="success"
            count={completedRuns.length}
            emptyText="Tamamlanmış görev yok."
            runs={completedRuns}
            groupByDay
            showDayFilter
            dayFilterKey={completedDayKey}
            onDayFilterChange={setCompletedDayKey}
          />
          <KanbanColumn
            title="İptal Edildi"
            emoji="❌"
            dot="cancel"
            count={cancelledRuns.length}
            emptyText="İptal edilmiş görev yok."
            runs={cancelledRuns}
            groupByDay
            showDayFilter
            dayFilterKey={cancelledDayKey}
            onDayFilterChange={setCancelledDayKey}
          />
        </div>
      )}
    </div>
  );
}
