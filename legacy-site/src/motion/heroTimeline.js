import { gsap } from 'gsap';

// Split a heading into per-word spans (with masking wrappers) for a line-rise reveal.
function splitWords(el) {
  const words = el.textContent.trim().split(/\s+/);
  el.textContent = '';
  return words.map((w) => {
    const mask = document.createElement('span');
    mask.style.display = 'inline-block';
    mask.style.overflow = 'hidden';
    mask.style.verticalAlign = 'top';
    const inner = document.createElement('span');
    inner.style.display = 'inline-block';
    inner.textContent = w;
    mask.appendChild(inner);
    el.appendChild(mask);
    el.appendChild(document.createTextNode(' '));
    return inner;
  });
}

// Cinematic hero entrance; `onReveal(v)` is called 0→1 to fade the DAG in.
export function playHeroIntro(onReveal) {
  const title = document.querySelector('.hero-title');
  const words = title ? splitWords(title) : [];

  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  gsap.set('.hero-eyebrow, .hero-tagline, .hero-lead, .import-bar, .hero-sub, .hero-proof', { opacity: 0, y: 14 });
  gsap.set(words, { yPercent: 110 });

  tl.to('.hero-eyebrow', { opacity: 1, y: 0, duration: 0.6 }, 0.1)
    .to(words, { yPercent: 0, duration: 1.0, stagger: 0.05 }, 0.2)
    .to('.hero-tagline', { opacity: 1, y: 0, duration: 0.7 }, 0.7)
    .to('.hero-lead', { opacity: 1, y: 0, duration: 0.7 }, 0.85)
    .to('.import-bar', { opacity: 1, y: 0, duration: 0.7 }, 1.0)
    .to('.hero-sub, .hero-proof', { opacity: 1, y: 0, duration: 0.7 }, 1.15);

  if (onReveal) {
    tl.to({ v: 0 }, { v: 1, duration: 1.6, ease: 'power2.out', onUpdate() { onReveal(this.targets()[0].v); } }, 0.3);
  }
  return tl;
}

// Static reveal (reduced motion) — no DAG fade choreography needed.
export function showHeroStatic(onReveal) {
  gsap.set('.hero-eyebrow, .hero-tagline, .hero-lead, .import-bar, .hero-sub, .hero-proof', { opacity: 1, y: 0 });
  if (onReveal) onReveal(1);
}
