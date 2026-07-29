'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { canRender3D, type SceneName } from '@/three/env';
import type { SceneProps } from '@/three/types';
import { useChapterProgress } from '@/three/useChapter';

// One dynamic boundary per scene, declared at module scope so the chunk is
// resolved once rather than per render. `ssr: false` is what keeps three out
// of the server bundle and out of the route's First Load JS; the import does
// not fire at all until `mounted` flips, so a visitor who never scrolls to a
// chapter never downloads it.
const SCENES: Record<SceneName, ComponentType<SceneProps>> = {
  lattice: dynamic(() => import('@/three/scenes/SpecLattice'), { ssr: false }),
  constellation: dynamic(() => import('@/three/scenes/McpConstellation'), { ssr: false }),
  lineage: dynamic(() => import('@/three/scenes/LineageGraph'), { ssr: false }),
  drift: dynamic(() => import('@/three/scenes/DriftScene'), { ssr: false }),
  score: dynamic(() => import('@/three/scenes/ScoreInstrument'), { ssr: false }),
};

export type SceneStageProps = {
  scene: SceneName;
  /**
   * The scene's static twin, rendered on the server. It is not a placeholder —
   * it carries the same claim as the scene and keeps its own role="img" and
   * aria-label for the entire life of the page, because a <canvas> tells a
   * screen reader nothing. No-JS, no-WebGL and reduced-motion visitors simply
   * never see anything else.
   */
  poster: ReactNode;
  className?: string;
};

export default function SceneStage({ scene, poster, className }: SceneStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const progress = useChapterProgress(hostRef);
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    // Asked after mount, never during render: every one of these checks reads
    // a browser API the server does not have, and guessing on the server then
    // correcting on the client is a hydration mismatch.
    if (!canRender3D(scene)) return;

    const host = hostRef.current;
    if (!host) return;
    if (!('IntersectionObserver' in window)) {
      setMounted(true);
      setActive(true);
      return;
    }

    let onScreen = false;
    const sync = () => setActive(onScreen && !document.hidden);

    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        // One-way: once a chapter has been reached the chunk stays loaded, so
        // scrolling back up does not re-download or re-initialise the context.
        if (onScreen) setMounted(true);
        sync();
      },
      { rootMargin: '20% 0px' },
    );
    io.observe(host);
    document.addEventListener('visibilitychange', sync);

    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [scene]);

  const Scene = mounted ? SCENES[scene] : null;

  return (
    <div
      className={className ? `scene ${className}` : 'scene'}
      ref={hostRef}
      data-live={mounted ? '' : undefined}
    >
      <div className="scene-poster">{poster}</div>
      {Scene ? <Scene active={active} progress={progress} /> : null}
    </div>
  );
}
