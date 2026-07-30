'use client';

import { usePathname } from 'next/navigation';

// The console's three rooms, always all visible — discoverability beats
// gating. Anonymous visitors clicking Dashboard hit the sign-in redirect,
// which is the correct introduction.
const TABS = [
  { href: '/app', label: 'Import' },
  { href: '/analyze', label: 'Deep analysis' },
  { href: '/dashboard', label: 'Dashboard' },
];

export default function ProductNav() {
  const pathname = usePathname();
  return (
    <nav className="app-tabs" aria-label="Console">
      {TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <a
            key={tab.href}
            className="app-tab"
            href={tab.href}
            aria-current={active ? 'page' : undefined}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
