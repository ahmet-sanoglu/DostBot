// Sol dikey menü — Kontrol Paneli, Görev Geçmişi ve Mühendis Paneli arasında geçiş.
// Görev Geçmişi: düz <a target="_blank"> — React Router Link SPA içi kalır; gerçek yeni sekme için native anchor.
// Henüz tamamlanmamış öğeler (Ayarlar) devre dışı buton olarak gösterilir.

import React from 'react';
import { Link, useLocation } from 'react-router-dom';

const SIDEBAR_ITEMS = [
  { id: 'control', icon: '🎛️', label: 'Kontrol Paneli', path: '/' },
  {
    id: 'history',
    icon: '📋',
    label: 'Görev Geçmişi',
    href: '/gorev-gecmisi',
    openInNewTab: true,
  },
  { id: 'settings', icon: '⚙️', label: 'Ayarlar', path: null },
  { id: 'engineer', icon: '🛠️', label: 'Mühendis Paneli', path: '/muhendis', openInNewTab: true },
];

/** Menü öğesinin aktif rotada olup olmadığını kontrol eder. */
function isItemActive(pathname, item) {
  if (item.href) return pathname === item.href;
  if (!item.path) return false;
  return pathname === item.path;
}

/** Sol kenar navigasyon menüsü. */
export default function Sidebar() {
  const { pathname } = useLocation();

  return (
    <nav className="sidebar" aria-label="Ana menü">
      {SIDEBAR_ITEMS.map((item) => {
        const active = isItemActive(pathname, item);
        const className = `sidebar-item ${active ? 'sidebar-item--active' : ''}`;

        // Gerçek yeni sekme: React Router Link değil, native <a>
        if (item.href) {
          return (
            <a
              key={item.id}
              href={item.href}
              className={className}
              title={item.label}
              {...(item.openInNewTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              <span className="sidebar-item__icon">{item.icon}</span>
              <span>{item.label}</span>
            </a>
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
  );
}
