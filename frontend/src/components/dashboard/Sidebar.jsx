import React from 'react';
import { Link, useLocation } from 'react-router-dom';

const SIDEBAR_ITEMS = [
  { id: 'live', icon: '📡', label: 'Canlı İzleme', path: '/' },
  { id: 'autonomous', icon: '🤖', label: 'Otonom Görevler', path: '/otonom' },
  { id: 'history', icon: '📋', label: 'Görev Geçmişi', path: null },
  { id: 'settings', icon: '⚙️', label: 'Ayarlar', path: null },
];

function isItemActive(pathname, item) {
  if (!item.path) return false;
  if (item.path === '/') {
    return pathname === '/' || pathname === '/canli-izleme';
  }
  return pathname === item.path;
}

export default function Sidebar() {
  const { pathname } = useLocation();

  return (
    <nav className="sidebar" aria-label="Ana menü">
      {SIDEBAR_ITEMS.map((item) => {
        const active = isItemActive(pathname, item);
        const className = `sidebar-item ${active ? 'sidebar-item--active' : ''}`;

        if (item.path) {
          return (
            <Link
              key={item.id}
              to={item.path}
              className={className}
              title={item.label}
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
  );
}
