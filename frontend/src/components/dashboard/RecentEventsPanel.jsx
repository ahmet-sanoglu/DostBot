// Son Olaylar paneli — navigasyon ve bağlantı olaylarının kronolojik listesi.
// Varsayılan kapalı; açılınca NavigationContext.recentEvents gösterilir.

import React, { useState } from 'react';
import { useNavigation } from '../../context/NavigationContext';

/** Genişletilebilir olay listesi; en yeni kayıtlar üstte. */
export default function RecentEventsPanel() {
  const { recentEvents } = useNavigation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`recent-events${expanded ? ' recent-events--expanded' : ''}`}>
      <button
        type="button"
        className="recent-events__toggle"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        Son Olaylar {expanded ? '▴' : '▾'}
      </button>

      {expanded && (
        <ul className="recent-events__list">
          {recentEvents.length === 0 ? (
            <li className="recent-events__item recent-events__item--empty">
              Henüz kayıtlı olay yok.
            </li>
          ) : (
            recentEvents.map((event) => (
              <li key={event.id} className="recent-events__item">
                <span className="recent-events__time">{event.time}</span>
                <span className="recent-events__message"> — {event.message}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
