'use client';

import { useEffect, useRef, useState } from 'react';

const TARGET = 87;
const RADIUS = 96;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const DURATION_MS = 1400;

export default function ScoreGauge() {
  // Server HTML (and no-JS visitors) get the finished reading; the effect
  // rewinds and animates only when JS + IntersectionObserver are available.
  const [value, setValue] = useState(TARGET);
  const rootRef = useRef<HTMLDivElement>(null);
  const raf = useRef<number>(0);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !('IntersectionObserver' in window) || !rootRef.current) return;
    setValue(0);
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        io.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / DURATION_MS);
          const eased = 1 - Math.pow(1 - t, 3);
          setValue(Math.round(eased * TARGET));
          if (t < 1) raf.current = requestAnimationFrame(tick);
        };
        raf.current = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    io.observe(rootRef.current);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf.current);
    };
  }, []);

  return (
    <div className="gauge" ref={rootRef} role="img" aria-label={`Example Agent-Ready Score: ${TARGET} out of 100`}>
      <svg viewBox="0 0 220 220" aria-hidden="true">
        <circle className="g-ticks" cx="110" cy="110" r="105" />
        <circle className="g-track" cx="110" cy="110" r={RADIUS} />
        <circle
          className="g-arc"
          cx="110"
          cy="110"
          r={RADIUS}
          style={{ strokeDasharray: CIRCUMFERENCE, strokeDashoffset: CIRCUMFERENCE * (1 - value / 100) }}
        />
      </svg>
      <div className="g-center">
        <div className="g-num">{value}</div>
        <div className="g-label">Agent-Ready</div>
      </div>
    </div>
  );
}
