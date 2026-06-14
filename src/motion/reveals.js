import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);
const EASE = 'power3.out';

// Scroll-in reveals for everything tagged .reveal
export function initReveals() {
  ScrollTrigger.batch('.reveal', {
    start: 'top 86%',
    once: true,
    onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, duration: 0.8, stagger: 0.09, ease: EASE }),
  });

  // pricing tiers: staggered
  const tiers = gsap.utils.toArray('#tiers .tier');
  if (tiers.length) {
    ScrollTrigger.create({
      trigger: '#tiers', start: 'top 82%', once: true,
      onEnter: () => tiers.forEach((t, i) => gsap.delayedCall(i * 0.07, () => t.classList.add('in'))),
    });
  }

  // class-toggle reveals that drive CSS keyed animations
  toggleOnEnter('#surfaces-grid', '#surfaces-grid', 'in');

  initDriftEvidence();
  initProofDemo();
}

// Stagger the four drift-evidence cards in; CSS drives each card's strike + highlight.
function initDriftEvidence() {
  const cards = gsap.utils.toArray('#drift-evidence .ev-card');
  if (!cards.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cards.forEach((c) => c.classList.add('in'));
    return;
  }
  ScrollTrigger.create({
    trigger: '#drift-evidence', start: 'top 82%', once: true,
    onEnter: () => cards.forEach((c, i) => gsap.delayedCall(i * 0.12, () => c.classList.add('in'))),
  });
}

// Build the MCP terminal like a live session: type the agent lines, sequence the rest.
function initProofDemo() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const term = document.getElementById('terminal');
  if (!term) return;
  const lines = gsap.utils.toArray(term.querySelectorAll('.term-line'));
  const caret = term.querySelector('.caret');

  // stash the typed text and clear it so it can be written out char-by-char
  const typed = gsap.utils.toArray(term.querySelectorAll('.type')).map((el) => {
    const full = el.textContent;
    el.textContent = '';
    return { el, full };
  });
  gsap.set(lines, { opacity: 0, y: 6 });
  if (caret) gsap.set(caret, { opacity: 0 });

  const typeLine = (t, dur) => {
    const o = { n: 0 };
    return gsap.to(o, {
      n: t.full.length, duration: dur, ease: 'none',
      onUpdate: () => { t.el.textContent = t.full.slice(0, Math.round(o.n)); },
    });
  };

  ScrollTrigger.create({
    trigger: term, start: 'top 78%', once: true,
    onEnter: () => {
      const tl = gsap.timeline();
      tl.to(lines[0], { opacity: 1, y: 0, duration: 0.25 })
        .add(typeLine(typed[0], 0.85))
        .to(lines[1], { opacity: 1, y: 0, duration: 0.3 }, '+=0.2')
        .to([lines[2], lines[3], lines[4]], { opacity: 1, y: 0, duration: 0.35, stagger: 0.2 }, '+=0.05')
        .to(lines[5], { opacity: 1, y: 0, duration: 0.3 }, '+=0.12')
        .to(lines[6], { opacity: 1, y: 0, duration: 0.25 }, '+=0.3');
      if (typed[1]) tl.add(typeLine(typed[1], 0.7));
      if (caret) tl.to(caret, { opacity: 1, duration: 0.15 }, '-=0.1');
    },
  });
}

function toggleOnEnter(triggerSel, targetSel, cls) {
  const el = document.querySelector(targetSel);
  if (!el) return;
  ScrollTrigger.create({ trigger: triggerSel, start: 'top 80%', once: true, onEnter: () => el.classList.add(cls) });
}

// Animated number counters for [data-count]
export function initCounters() {
  gsap.utils.toArray('[data-count]').forEach((el) => {
    const target = parseFloat(el.dataset.count);
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    const obj = { v: 0 };
    ScrollTrigger.create({
      trigger: el, start: 'top 92%', once: true,
      onEnter: () => gsap.to(obj, {
        v: target, duration: 1.2, ease: 'power2.out',
        onUpdate: () => { el.textContent = prefix + Math.round(obj.v).toLocaleString() + suffix; },
      }),
    });
  });
}

// Magnetic hover for [data-magnetic]
export function initMagnetic() {
  if (window.matchMedia('(hover: none)').matches) return;
  gsap.utils.toArray('[data-magnetic]').forEach((el) => {
    const xTo = gsap.quickTo(el, 'x', { duration: 0.4, ease: 'power3.out' });
    const yTo = gsap.quickTo(el, 'y', { duration: 0.4, ease: 'power3.out' });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      xTo((e.clientX - (r.left + r.width / 2)) * 0.35);
      yTo((e.clientY - (r.top + r.height / 2)) * 0.45);
    });
    el.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
  });
}

// 3D tilt for .tilt cards
export function initTilt() {
  if (window.matchMedia('(hover: none)').matches) return;
  gsap.utils.toArray('.tilt').forEach((el) => {
    const rxTo = gsap.quickTo(el, 'rotationX', { duration: 0.5, ease: 'power3.out' });
    const ryTo = gsap.quickTo(el, 'rotationY', { duration: 0.5, ease: 'power3.out' });
    gsap.set(el, { transformPerspective: 800, transformOrigin: 'center' });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      ryTo(px * 8); rxTo(-py * 8);
    });
    el.addEventListener('pointerleave', () => { rxTo(0); ryTo(0); });
  });
}

// Nav background + scroll progress bar
export function initChrome() {
  const nav = document.getElementById('nav');
  const bar = document.getElementById('scroll-progress');
  const update = () => {
    const y = window.scrollY || document.documentElement.scrollTop;
    if (nav) nav.classList.toggle('scrolled', y > 16);
    if (bar) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
    }
  };
  ScrollTrigger.create({ start: 0, end: 'max', onUpdate: update });
  update();
}
