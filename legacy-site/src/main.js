import './styles/tokens.css';
import './styles/base.css';
import './styles/sections.css';

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { supportsWebGL, prefersReducedMotion } from './three/renderer.js';
import { initSmoothScroll } from './motion/smoothScroll.js';
import { initReveals, initCounters, initChrome } from './motion/reveals.js';
import { playHeroIntro, showHeroStatic } from './motion/heroTimeline.js';
import { initLayersScroll, initLayersStatic } from './motion/layersScroll.js';
import { initImportDemo } from './motion/importDemo.js';
import { initImportHero } from './motion/importHero.js';
import { initScoreGauge } from './motion/scoreGauge.js';
import { APP_ORIGIN } from './config.js';

gsap.registerPlugin(ScrollTrigger);

const webgl = supportsWebGL();
const reduced = prefersReducedMotion;

async function boot() {
  if (!webgl) document.body.classList.add('no-webgl');

  // waitlist form — POSTs to the Spotcheck app unless index.html overrides it
  const form = document.getElementById('cta-form');
  if (form) {
    if (!form.dataset.endpoint) form.dataset.endpoint = `${APP_ORIGIN}/api/waitlist`;
    const status = document.getElementById('form-status');
    const say = (msg) => { if (status) status.textContent = msg; };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.querySelector('.hp-field')?.value) return; // honeypot
      const email = form.querySelector('input[type="email"]');
      const endpoint = form.dataset.endpoint;
      if (!endpoint) {
        email.value = '';
        say("Thanks — you're on the list. We'll email your import link.");
        return;
      }
      try {
        say('…');
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.value }),
        });
        if (!res.ok) throw new Error(res.statusText);
        email.value = '';
        say("Thanks — you're on the list. We'll email your import link.");
      } catch {
        say("Something went wrong — email hello@spotcheck.dev and we'll add you.");
      }
    });
  }

  // chrome + non-3D motion (works in every mode)
  initChrome();
  initCounters();
  initReveals();
  const demo = initImportDemo();
  initImportHero({ demoPlay: demo?.play ?? null });
  initScoreGauge();

  if (!reduced) initSmoothScroll();

  const pending = [];

  // ---- HERO: Living Entity DAG ----
  if (webgl) {
    pending.push(import('./three/DagScene.js').then(({ createDagScene }) => {
      const dag = createDagScene(
        document.getElementById('dag-canvas'),
        document.getElementById('dag-labels')
      );
      if (reduced) {
        dag.setReveal(1);
        dag.renderOnce();
        showHeroStatic();
      } else {
        dag.start();
        playHeroIntro((v) => dag.setReveal(v));
      }
    }));
  } else {
    showHeroStatic();
  }

  // ---- LAYERS: pinned build sequence ----
  if (webgl && !reduced) {
    pending.push(import('./three/LayersScene.js').then(({ createLayersScene }) => {
      const layers = createLayersScene(document.getElementById('layers-canvas'));
      layers.start();
      initLayersScroll(layers);
    }));
  } else {
    initLayersStatic();
  }

  // ---- THE QUESTION: drift field resolves chaos → order as you read ----
  if (webgl && !reduced) {
    pending.push(import('./three/DriftScene.js').then(({ createDriftScene }) => {
      const drift = createDriftScene(document.getElementById('drift-canvas'));
      drift.start();
      ScrollTrigger.create({
        trigger: '#anxiety', start: 'top bottom', end: 'bottom top', scrub: true,
        onUpdate: (s) => drift.setProgress(1 - s.progress),
      });
    }));
  }

  // ---- CTA: converging ambient field ----
  if (webgl && !reduced) {
    pending.push(import('./three/AmbientField.js').then(({ createAmbientField }) => {
      const cta = createAmbientField(document.getElementById('cta-canvas'), { mode: 'converge', color: 'blue' });
      cta.start();
      ScrollTrigger.create({
        trigger: '#start', start: 'top 85%', end: 'center center', scrub: true,
        onUpdate: (s) => cta.setProgress(s.progress),
      });
    }));
  }

  await Promise.all(pending);
  ScrollTrigger.refresh();
}

boot();

// Recompute pin/trigger positions once fonts settle and on full load.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => ScrollTrigger.refresh());
window.addEventListener('load', () => ScrollTrigger.refresh());
