'use client';

import { useEffect } from 'react';

/**
 * Lenis, loaded only when it will actually be used.
 *
 * Smooth scroll is the substrate the whole chaptered page sits on — the
 * scenes are scrubbed by scroll position, and native wheel deltas make a
 * scrubbed camera look like a flipbook. But it is also exactly the kind of
 * scroll-hijacking that reduced-motion exists to refuse, so the import is
 * behind the same gate the scenes are: no preference, no download.
 */
export default function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const root = document.documentElement;
    let lenis: { raf: (t: number) => void; destroy: () => void; scrollTo: (t: HTMLElement | number, o?: object) => void } | null = null;
    let raf = 0;
    let cancelled = false;

    // CSS smooth scrolling and Lenis fight over the same gesture, and the
    // visible result is a scroll that overshoots and springs back.
    const previousBehaviour = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';

    // Native anchor jumps become instant once scroll-behavior is off, so hand
    // in-page links to Lenis instead of losing the smooth jump entirely.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.('a[href^="#"]');
      if (!anchor || !lenis) return;
      const id = anchor.getAttribute('href')?.slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      lenis.scrollTo(target, { offset: -84 }); // clears the 64px sticky header
      history.replaceState(null, '', `#${id}`);
    };

    import('lenis')
      .then(({ default: Lenis }) => {
        if (cancelled) return;
        lenis = new Lenis({ duration: 1.05, smoothWheel: true, touchMultiplier: 1.6 });
        const tick = (time: number) => {
          lenis?.raf(time);
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        document.addEventListener('click', onClick);
      })
      .catch(() => {
        // A failed chunk must not cost the visitor their scrollbar.
        root.style.scrollBehavior = previousBehaviour;
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('click', onClick);
      lenis?.destroy();
      root.style.scrollBehavior = previousBehaviour;
    };
  }, []);

  return null;
}
