import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const TOTAL = 6;

/**
 * Pins the What-you-get section and scrubs through the 6 surfaces one import
 * produces, driving both the 3D model (scene.setProgress) and the active card.
 */
export function initLayersScroll(scene) {
  const pin = document.getElementById('layers-pin');
  const cards = gsap.utils.toArray('.layer-card');
  const current = document.querySelector('#layers-progress .lp-current');
  if (!pin) return;

  let activeIdx = -1;
  const setActive = (idx) => {
    if (idx === activeIdx) return;
    activeIdx = idx;
    cards.forEach((c, i) => c.classList.toggle('active', i === idx));
    if (current) current.textContent = String(idx + 1).padStart(2, '0');
  };
  setActive(0);

  ScrollTrigger.create({
    trigger: pin,
    start: 'top top',
    end: '+=320%',
    pin: true,
    scrub: 0.6,
    onUpdate: (self) => {
      const p = self.progress;
      if (scene) scene.setProgress(p);
      const idx = Math.min(TOTAL - 1, Math.floor(p * TOTAL));
      setActive(idx);
    },
  });
}

// Reduced-motion / no-WebGL fallback: stack the cards, no pin.
export function initLayersStatic() {
  document.body.classList.add('layers-static');
  gsap.utils.toArray('.layer-card').forEach((c) => c.classList.add('active'));
}
