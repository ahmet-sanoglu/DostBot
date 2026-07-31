// Sol dikey menü — Kontrol Paneli, Görev Geçmişi (modal) ve Mühendis Paneli arasında geçiş.
// Henüz tamamlanmamış öğeler (Ayarlar) devre dışı buton olarak gösterilir.

import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import TaskHistoryModal from './TaskHistoryModal';

const SIDEBAR_ITEMS = [
  { id: 'control', icon: '🎛️', label: 'Kontrol Paneli', path: '/' },
  { id: 'history', icon: '📋', label: 'Görev Geçmişi', action: 'taskHistory' },
  { id: 'settings', icon: '⚙️', label: 'Ayarlar', path: null },
  { id: 'engineer', icon: '🛠️', label: 'Mühendis Paneli', path: '/muhendis', openInNewTab: true },
];

/** Menü öğesinin aktif rotada olup olmadığını kontrol eder. */
function isItemActive(pathname, item, showTaskHistory) {
  if (item.action === 'taskHistory') return showTaskHistory;
  if (!item.path) return false;
  return pathname === item.path;
}

/** Sol kenar navigasyon menüsü. */
export default function Sidebar() {
  const { pathname } = useLocation();
  const [showTaskHistory, setShowTaskHistory] = useState(false);

  return (
    <>
      <nav className="sidebar" aria-label="Ana menü">
        {SIDEBAR_ITEMS.map((item) => {
          const active = isItemActive(pathname, item, showTaskHistory);
          const className = `sidebar-item ${active ? 'sidebar-item--active' : ''}`;

          if (item.action === 'taskHistory') {
            return (
              <button
                key={item.id}
                type="button"
                className={className}
                title={item.label}
                onClick={() => setShowTaskHistory(true)}
              >
                <span className="sidebar-item__icon">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            );
          }

          if (item.path) {
            return (
              <Link
                key={item.id}
                to={item.path}
                className={className}
                title={item.label}
                {...(item.openInNewTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                <span className="sidebar-item__icon">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          }

          return (
            <button
              key={item.id}
              type="button"
              className={className}
              title={item.label}
              disabled
            >
              <span className="sidebar-item__icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <TaskHistoryModal
        open={showTaskHistory}
        onClose={() => setShowTaskHistory(false)}
      />
    </>
  );
}
