import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const CIRC = 2 * Math.PI * 96; // matches r=96 in the SVG
const SCORE = 87;

// Agent-Ready Score gauge: arc sweeps to 87, sub-score bars fill.
// Markup ships in its final state; reduced-motion leaves it untouched.
export function initScoreGauge() {
  const gauge = document.getElementById('score-gauge');
  if (!gauge) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const arc = gauge.querySelector('#score-arc');
  const num = gauge.querySelector('#score-num');
  const bars = gsap.utils.toArray(document.querySelectorAll('#subscores .ss-bar i'));

  gsap.set(arc, { strokeDashoffset: CIRC });
  gsap.set(bars, { scaleX: 0 });
  if (num) num.textContent = '0';

  ScrollTrigger.create({
    trigger: gauge, start: 'top 78%', once: true,
    onEnter: () => {
      const tl = gsap.timeline();
      // needle physics: fast attack past the mark, then damp back to 87
      const OVERSHOOT = Math.min(100, SCORE + 2);
      tl.to(arc, { strokeDashoffset: CIRC * (1 - OVERSHOOT / 100), duration: 1.0, ease: 'power3.out' })
        .to(arc, { strokeDashoffset: CIRC * (1 - SCORE / 100), duration: 0.7, ease: 'power2.inOut' });
      if (num) {
        const s = { v: 0 };
        tl.to(s, {
          v: OVERSHOOT, duration: 1.0, ease: 'power3.out',
          onUpdate: () => { num.textContent = String(Math.round(s.v)); },
        }, 0).to(s, {
          v: SCORE, duration: 0.7, ease: 'power2.inOut',
          onUpdate: () => { num.textContent = String(Math.round(s.v)); },
        }, 1.0);
      }
      tl.to(bars, { scaleX: 1, duration: 0.8, stagger: 0.12, ease: 'power3.out' }, 0.3);
    },
  });
}
