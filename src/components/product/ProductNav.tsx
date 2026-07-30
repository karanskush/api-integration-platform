'use client';

import { usePathname } from 'next/navigation';

// One door in: Import. Deep analysis is deliberately NOT a tab — it is step
// two of the same funnel, offered from the workspace an import produces
// (and from /analyze directly, which stays routable). Anonymous visitors
// clicking Dashboard hit the sign-in redirect, which is the correct
// introduction.
const TABS = [
  { href: '/app', label: 'Import' },
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
