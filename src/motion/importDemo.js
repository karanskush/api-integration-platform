import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// The simulated import: URL types itself, the parse log streams in, the
// playground + minted MCP URL land, the score counts up. Markup ships in its
// final state so reduced-motion / no-JS readers see the finished frame.
export function initImportDemo() {
  const win = document.getElementById('import-demo');
  if (!win) return { play: null };

  const replayBtn = document.getElementById('demo-replay');

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (replayBtn) replayBtn.style.display = 'none';
    return { play: null };
  }

  const urlEl = win.querySelector('#demo-url');
  const logs = gsap.utils.toArray(win.querySelectorAll('.dlog'));
  const result = win.querySelector('#demo-result');
  const rows = gsap.utils.toArray(win.querySelectorAll('.dp-row, .dp-resp'));
  const mcpBits = gsap.utils.toArray(win.querySelectorAll('.dm-url, .dm-hint, .dm-score'));
  const scoreEl = win.querySelector('#demo-score');
  const cta = win.querySelector('#demo-cta');

  const fullUrl = urlEl.textContent;
  let tl = null;

  const reset = () => {
    urlEl.textContent = '';
    if (scoreEl) scoreEl.textContent = '0';
    gsap.set(logs, { opacity: 0, y: 6 });
    gsap.set(result, { opacity: 0, y: 14 });
    gsap.set([...rows, ...mcpBits], { opacity: 0, y: 8 });
    gsap.set(cta, { opacity: 0 });
  };

  const play = () => {
    if (tl) tl.kill();
    reset();
    tl = gsap.timeline();
    const typer = { n: 0 };
    tl.to(typer, {
      n: fullUrl.length, duration: 1.1, ease: 'none',
      onUpdate: () => { urlEl.textContent = fullUrl.slice(0, Math.round(typer.n)); },
    });
    logs.forEach((l) => tl.to(l, { opacity: 1, y: 0, duration: 0.3 }, '+=0.22'));
    tl.to(result, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, '+=0.25')
      .to(rows, { opacity: 1, y: 0, duration: 0.35, stagger: 0.14, ease: 'power3.out' }, '-=0.15')
      .to(mcpBits, { opacity: 1, y: 0, duration: 0.35, stagger: 0.14, ease: 'power3.out' }, '<+0.1');
    if (scoreEl) {
      const s = { v: 0 };
      tl.to(s, {
        v: 87, duration: 1.0, ease: 'power2.out',
        onUpdate: () => { scoreEl.textContent = String(Math.round(s.v)); },
      }, '-=0.2');
    }
    tl.to(cta, { opacity: 1, duration: 0.5 }, '-=0.4');
  };

  reset();
  ScrollTrigger.create({ trigger: win, start: 'top 72%', once: true, onEnter: play });
  if (replayBtn) replayBtn.addEventListener('click', play);

  return { play };
}
