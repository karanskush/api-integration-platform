import './styles/tokens.css';
import './styles/base.css';
import './styles/sections.css';

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { supportsWebGL, prefersReducedMotion } from './three/renderer.js';
import { initSmoothScroll } from './motion/smoothScroll.js';
import { initReveals, initCounters, initMagnetic, initTilt, initChrome } from './motion/reveals.js';
import { playHeroIntro, showHeroStatic } from './motion/heroTimeline.js';
import { initLayersScroll, initLayersStatic } from './motion/layersScroll.js';

gsap.registerPlugin(ScrollTrigger);

const webgl = supportsWebGL();
const reduced = prefersReducedMotion;

async function boot() {
  if (!webgl) document.body.classList.add('no-webgl');

  // form handler
  const form = document.getElementById('cta-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      input.value = '';
      input.placeholder = "Thanks — you're on the list.";
    });
  }

  // chrome + non-3D motion (works in every mode)
  initChrome();
  initCounters();
  initMagnetic();
  initTilt();
  initReveals();

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

  // ---- PROBLEM: cinematic drift field ----
  if (webgl && !reduced) {
    pending.push(import('./three/DriftScene.js').then(({ createDriftScene }) => {
      const drift = createDriftScene(document.getElementById('drift-canvas'));
      drift.start();
      ScrollTrigger.create({
        trigger: '#problem', start: 'top bottom', end: 'bottom top', scrub: true,
        onUpdate: (s) => drift.setProgress(s.progress),
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
