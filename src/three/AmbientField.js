import * as THREE from 'three';
import { createRenderer, fitToCanvas, createLoop, dotTexture, COLORS, isMobile } from './renderer.js';

/**
 * Lightweight transparent particle field used as a section accent.
 *  mode 'drift'    — ordered lattice that perturbs into noise as progress 0→1
 *  mode 'converge' — scattered cloud that coalesces toward the centre as 0→1
 */
export function createAmbientField(canvas, { mode = 'drift', color = 'beige' } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.z = 9;

  const renderer = createRenderer(canvas, { alpha: true });

  const COUNT = isMobile ? 320 : 720;
  const a = new Float32Array(COUNT * 3); // start
  const b = new Float32Array(COUNT * 3); // end
  const pos = new Float32Array(COUNT * 3);

  const cols = Math.ceil(Math.sqrt(COUNT));
  for (let i = 0; i < COUNT; i++) {
    if (mode === 'drift') {
      // ordered lattice → noisy cloud
      const gx = (i % cols) / (cols - 1) - 0.5;
      const gy = Math.floor(i / cols) / (cols - 1) - 0.5;
      a[i * 3] = gx * 16; a[i * 3 + 1] = gy * 9; a[i * 3 + 2] = (Math.random() - 0.5) * 1.5;
      b[i * 3] = a[i * 3] + (Math.random() - 0.5) * 5;
      b[i * 3 + 1] = a[i * 3 + 1] + (Math.random() - 0.5) * 4;
      b[i * 3 + 2] = (Math.random() - 0.5) * 6;
    } else {
      // scattered → converge toward a soft centre
      const r = 5 + Math.random() * 5, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      a[i * 3] = r * Math.sin(ph) * Math.cos(th);
      a[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.6;
      a[i * 3 + 2] = r * Math.cos(ph) * 0.5;
      b[i * 3] = (Math.random() - 0.5) * 2.2;
      b[i * 3 + 1] = (Math.random() - 0.5) * 1.4;
      b[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
    }
    pos[i * 3] = a[i * 3]; pos[i * 3 + 1] = a[i * 3 + 1]; pos[i * 3 + 2] = a[i * 3 + 2];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

  const c = color === 'blue' ? COLORS.blue : COLORS.beige;
  const mat = new THREE.PointsMaterial({
    size: isMobile ? 0.07 : 0.06,
    map: dotTexture(),
    color: c,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  let progress = 0, shown = 0;
  const setProgress = (p) => { progress = Math.max(0, Math.min(1, p)); };

  fitToCanvas(renderer, camera, canvas);

  function update(dt, time) {
    shown += ((1) - shown) * Math.min(1, dt * 1.5);
    const ease = mode === 'converge' ? progress * progress : progress;
    for (let i = 0; i < COUNT; i++) {
      const o = i * 3;
      const wob = Math.sin(time * 0.5 + i) * 0.04;
      pos[o] = a[o] + (b[o] - a[o]) * ease + wob;
      pos[o + 1] = a[o + 1] + (b[o + 1] - a[o + 1]) * ease;
      pos[o + 2] = a[o + 2] + (b[o + 2] - a[o + 2]) * ease;
    }
    geo.attributes.position.needsUpdate = true;
    points.rotation.y = time * 0.02;
    const targetOpacity = mode === 'converge' ? 0.25 + progress * 0.5 : 0.45;
    mat.opacity = shown * targetOpacity;
    renderer.render(scene, camera);
  }

  const loop = createLoop(canvas, update);
  return { setProgress, start: loop.start, stop: loop.stop, renderOnce: loop.renderOnce };
}
