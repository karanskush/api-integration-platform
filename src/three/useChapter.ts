'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * How far a chapter has travelled through the viewport, 0 → 1.
 *
 * 0 is "the top edge has just reached the bottom of the screen", 1 is "the
 * bottom edge has just left the top". Scenes read this inside useFrame to
 * drive a camera or a timeline, which is why it is handed back as a ref
 * rather than as state: this value changes on every scroll frame, and putting
 * it through React would re-render the whole subtree sixty times a second to
 * move a camera that React does not own.
 */
export function useChapterProgress(hostRef: RefObject<HTMLElement | null>): RefObject<number> {
  const progress = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let raf = 0;
    let queued = false;

    const measure = () => {
      queued = false;
      const rect = host.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      const travel = vh + rect.height;
      progress.current = travel > 0 ? clamp01((vh - rect.top) / travel) : 0;
    };

    // Scroll fires far more often than a frame renders, so coalesce to one
    // layout read per frame. Reading getBoundingClientRect per scroll event
    // is the classic way to turn smooth scrolling into a stutter.
    const onScroll = () => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [hostRef]);

  return progress;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Remap `v` from [inMin, inMax] to [outMin, outMax], clamped at both ends. */
export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  const t = clamp01((v - inMin) / (inMax - inMin || 1));
  return outMin + t * (outMax - outMin);
}

/** Smoothstep easing — the one that makes a scrubbed camera stop feeling linear. */
export function ease(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

/**
 * Frame-rate independent exponential approach. `lambda` is roughly "how many
 * e-folds per second", so the same call behaves identically at 60 and 120 Hz —
 * a plain `current += (target - current) * 0.1` does not.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}
