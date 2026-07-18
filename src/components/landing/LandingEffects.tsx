'use client';

import { useEffect } from 'react';

const SEEN_KEY = 'sc-landing-revealed';

function alreadySeen(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* private mode — animations just replay next visit */
  }
}

// Progressive reveal for the landing sections. The hidden state only exists
// under html.js-landing (added here, after hydration), so no-JS visitors and
// crawlers always see the full page. Reduced-motion users get everything
// immediately, and back-navigation within a session skips the theater instead
// of re-hiding an already-seen viewport.
export default function LandingEffects() {
  useEffect(() => {
    const root = document.documentElement;
    const els = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.classList.add('js-landing');

    if (reduced || alreadySeen() || !('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('in'));
      markSeen();
      return () => root.classList.remove('js-landing');
    }

    markSeen();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    els.forEach((el) => io.observe(el));

    return () => {
      io.disconnect();
      root.classList.remove('js-landing');
    };
  }, []);

  return null;
}
