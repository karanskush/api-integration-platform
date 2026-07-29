// What this browser is actually willing to do, asked once and cached.
//
// The rule the whole 3D layer hangs off: a scene is an *enhancement*. Every
// one of them has a static poster twin that carries the same claim, and the
// poster is what the server renders. So these checks never have to degrade
// gracefully — they just answer yes or no, and "no" costs the visitor
// nothing, not even the download.

export type SceneName = 'lattice' | 'constellation' | 'lineage' | 'drift' | 'score';

let webglSupport: boolean | null = null;

/** Ported from legacy-site/src/three/renderer.js — same probe, same caveats. */
export function supportsWebGL(): boolean {
  if (webglSupport !== null) return webglSupport;
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    webglSupport = Boolean(
      window.WebGLRenderingContext && (canvas.getContext('webgl2') || canvas.getContext('webgl')),
    );
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A rough "this device will not enjoy five WebGL scenes" test.
 *
 * Viewport width is the honest majority signal; hardwareConcurrency catches
 * the low-core laptops that are wide but slow. Neither is precise, and that
 * is fine — being wrong here costs a poster, not a broken page.
 */
export function isLowPower(): boolean {
  if (typeof window === 'undefined') return true;
  if (window.matchMedia('(max-width: 760px)').matches) return true;
  const cores = navigator.hardwareConcurrency;
  return typeof cores === 'number' && cores > 0 && cores <= 4;
}

/**
 * Whether a given scene may run at all.
 *
 * On a low-power device only the hero scene survives, and it runs a reduced
 * build (see SpecLattice's `budget`). Four more canvases below the fold is
 * how a landing page ends up janking a phone for the entire scroll.
 */
export function canRender3D(scene: SceneName): boolean {
  if (prefersReducedMotion()) return false;
  if (!supportsWebGL()) return false;
  if (isLowPower()) return scene === 'lattice';
  return true;
}
