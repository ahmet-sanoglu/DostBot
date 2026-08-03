// Kontrol paneli ↔ Görev Geçmişi (yeni sekme) senkronu.
// Neden BroadcastChannel? History target=_blank ile ayrı React ağacı açar;
// NavigationContext state paylaşılmaz — canlı görev + geçmiş yenileme buradan geçer.

const CHANNEL_NAME = 'agrifleet-navigation';
const SNAPSHOT_KEY = 'agrifleet:nav-snapshot';

let channel = null;

function getChannel() {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null;
  }
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
  }
  return channel;
}

/** localStorage'daki son snapshot (yeni sekme açılışında). */
export function readNavSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Canlı navigasyon anlık görüntüsü yayınla (activeTask / queueBusy / hedef).
 * @param {object} snapshot
 */
export function publishNavSnapshot(snapshot) {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // kota / gizli mod — yayın yine denensin
  }
  const ch = getChannel();
  ch?.postMessage({ type: 'nav-snapshot', snapshot });
}

/**
 * Terminal geçmiş kaydı / queue idle sonrası — açık Görev Geçmişi sekmesi GET yapsın.
 * Neden? History ayrı sekmede; NavigationContext state paylaşılmaz.
 * @param {{ status?: string, taskName?: string }} detail
 */
export function publishTaskHistoryUpdated(detail) {
  const payload = { type: 'task-history-updated', ...detail };
  const ch = getChannel();
  ch?.postMessage(payload);
  try {
    // storage event: diğer sekmeler (BroadcastChannel yoksa yedek)
    localStorage.setItem(
      'agrifleet:task-history-tick',
      String(Date.now()),
    );
  } catch {
    // ignore
  }
  // Aynı sekme: BroadcastChannel gönderene gitmez
  window.dispatchEvent(new CustomEvent('agrifleet:task-history-updated', { detail: payload }));
}

/**
 * @param {(msg: { type: string, snapshot?: object, status?: string }) => void} handler
 * @returns {() => void} unsubscribe
 */
export function subscribeNavigationBroadcast(handler) {
  const ch = getChannel();
  const onMessage = (event) => {
    if (event?.data) handler(event.data);
  };
  ch?.addEventListener('message', onMessage);

  const onStorage = (event) => {
    if (event.key === SNAPSHOT_KEY && event.newValue) {
      try {
        handler({ type: 'nav-snapshot', snapshot: JSON.parse(event.newValue) });
      } catch {
        // ignore
      }
    }
    if (event.key === 'agrifleet:task-history-tick' && event.newValue) {
      handler({ type: 'task-history-updated' });
    }
  };
  window.addEventListener('storage', onStorage);

  const onLocal = (event) => {
    if (event?.detail) handler(event.detail);
  };
  window.addEventListener('agrifleet:task-history-updated', onLocal);

  return () => {
    ch?.removeEventListener('message', onMessage);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('agrifleet:task-history-updated', onLocal);
  };
}
