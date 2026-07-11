import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);
const EASE = 'power3.out';

// Scroll-in reveals for everything tagged .reveal
export function initReveals() {
  ScrollTrigger.batch('.reveal', {
    start: 'top 86%',
    once: true,
    onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, duration: 0.5, stagger: 0.04, ease: EASE }),
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

  initProofDemo();
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
      lines.forEach((line, i) => {
        const isBeat = line.classList.contains('warn') || line.classList.contains('ok');
        tl.to(line, { opacity: 1, y: 0, duration: 0.3 }, i === 0 ? undefined : isBeat ? '+=0.3' : '+=0.12');
        const t = typed.find((x) => line.contains(x.el));
        if (t) tl.add(typeLine(t, Math.min(1, t.full.length * 0.028)));
      });
      if (caret) tl.to(caret, { opacity: 1, duration: 0.15 }, '-=0.1');
    },
  });
}

function toggleOnEnter(triggerSel, targetSel, cls) {
  const el = document.querySelector(targetSel);
  if (!el) return;
  ScrollTrigger.create({ trigger: triggerSel, start: 'top 80%', once: true, onEnter: () => el.classList.add(cls) });
}

// Animated number counters for [data-count]. Markup ships final values, so
// reduced-motion readers simply keep them.
export function initCounters() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
