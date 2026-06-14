import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export const DPR = Math.min(window.devicePixelRatio || 1, 2);
export const isMobile = window.matchMedia('(max-width: 760px)').matches;
export const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const COLORS = {
  bg: new THREE.Color('#0b0906'),
  beige: new THREE.Color('#e6d6a8'),
  beigeDim: new THREE.Color('#8c7e5e'),
  blue: new THREE.Color('#84a8cf'),
  red: new THREE.Color('#d98b7a'),
};

export function supportsWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

export function createRenderer(canvas, { alpha = true } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha,
    antialias: !isMobile,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(DPR);
  renderer.setClearColor(0x000000, 0);
  return renderer;
}

/** Keep renderer + camera sized to the canvas's CSS box. Returns the resize fn. */
export function fitToCanvas(renderer, camera, canvas, onSize) {
  const resize = () => {
    const w = canvas.clientWidth || canvas.offsetWidth || window.innerWidth;
    const h = canvas.clientHeight || canvas.offsetHeight || window.innerHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    if (camera.isPerspectiveCamera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    if (onSize) onSize(w, h);
  };
  resize();
  window.addEventListener('resize', resize, { passive: true });
  return resize;
}

/** A soft radial dot texture — bakes the glow so additive blending reads as light. */
export function dotTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** RAF loop that pauses when the tab is hidden or the canvas is off-screen. */
export function createLoop(canvas, render) {
  let raf = null;
  let visible = !document.hidden;
  let onScreen = true;
  let last = performance.now();
  let elapsed = 0;

  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!visible || !onScreen) return;
    elapsed += dt;
    render(dt, elapsed);
  };

  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    last = performance.now();
  });

  const io = new IntersectionObserver(
    ([e]) => { onScreen = e.isIntersecting; last = performance.now(); },
    { rootMargin: '160px' }
  );
  io.observe(canvas);

  const start = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } };
  const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = null; } };
  return { start, stop, renderOnce: () => render(0, elapsed) };
}

/** EffectComposer with a tuned UnrealBloom pass (for opaque-background scenes). */
export function makeBloomComposer(renderer, scene, camera, canvas, { strength = 0.7, radius = 0.6, threshold = 0.0 } = {}) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), strength, radius, threshold);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const setSize = (ww, hh) => composer.setSize(ww, hh);
  return { composer, bloom, setSize };
}
