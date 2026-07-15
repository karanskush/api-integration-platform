import * as THREE from 'three';
import { NODES, EDGES, CHAINS } from '../data/graph.js';
import {
  createRenderer, fitToCanvas, createLoop, dotTexture, makeBloomComposer,
  COLORS, isMobile,
} from './renderer.js';

/**
 * The hero "Living Entity DAG": endpoint nodes wired by dependency edges, with
 * call-sequence pulses tracing valid chains. Mouse-reactive, bloom-lit.
 */
export function createDagScene(canvas, labelLayer) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
  camera.position.set(0, 0, 9.4);

  const renderer = createRenderer(canvas, { alpha: false });
  renderer.setClearColor(COLORS.bg, 1);

  const group = new THREE.Group();
  scene.add(group);

  const N = NODES.length;
  const base = NODES.map((n) => new THREE.Vector3(...n.pos));
  const cur = base.map((v) => v.clone());
  const glow = new Float32Array(N);           // 0..1, decays each frame
  const baseColor = NODES.map((n) => (n.kind === 'agent' ? COLORS.secondary : COLORS.primary));
  const baseSize = NODES.map((n) => (n.kind === 'agent' ? 0.62 : 0.5));

  const tex = dotTexture();

  // ---- shared point shader (per-point size + color) ----
  const pointMat = (opacity, blending) => new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex }, uScale: { value: 1 }, uOpacity: { value: opacity } },
    vertexShader: `
      attribute float aSize; attribute vec3 aColor; varying vec3 vColor;
      uniform float uScale;
      void main(){
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uTex; uniform float uOpacity; varying vec3 vColor;
      void main(){
        vec4 t = texture2D(uTex, gl_PointCoord);
        gl_FragColor = vec4(vColor, t.a * uOpacity);
      }`,
    transparent: true, depthWrite: false, blending,
  });

  // ---- nodes ----
  const nodeGeo = new THREE.BufferGeometry();
  const nPos = new Float32Array(N * 3);
  const nCol = new Float32Array(N * 3);
  const nSize = new Float32Array(N);
  nodeGeo.setAttribute('position', new THREE.BufferAttribute(nPos, 3));
  nodeGeo.setAttribute('aColor', new THREE.BufferAttribute(nCol, 3));
  nodeGeo.setAttribute('aSize', new THREE.BufferAttribute(nSize, 1));
  const nodeMat = pointMat(0, THREE.NormalBlending);
  const nodePoints = new THREE.Points(nodeGeo, nodeMat);
  nodePoints.frustumCulled = false;
  group.add(nodePoints);

  // ---- edges ----
  const edgeGeo = new THREE.BufferGeometry();
  const ePos = new Float32Array(EDGES.length * 2 * 3);
  const eCol = new Float32Array(EDGES.length * 2 * 3);
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
  edgeGeo.setAttribute('color', new THREE.BufferAttribute(eCol, 3));
  const edgeMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false });
  const edges = new THREE.LineSegments(edgeGeo, edgeMat);
  edges.frustumCulled = false;
  group.add(edges);

  // ---- pulses (one packet per chain) ----
  const P = CHAINS.length;
  const pulseGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(P * 3);
  const pCol = new Float32Array(P * 3);
  const pSize = new Float32Array(P);
  pulseGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pulseGeo.setAttribute('aColor', new THREE.BufferAttribute(pCol, 3));
  pulseGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
  const pulseMat = pointMat(0, THREE.AdditiveBlending);
  const pulses = new THREE.Points(pulseGeo, pulseMat);
  pulses.frustumCulled = false;
  group.add(pulses);

  // packets are verification probes — green is earned by traffic that lands
  const packets = CHAINS.map((chain, i) => ({
    chain, seg: 0, t: i * 0.33, speed: 0.5 + i * 0.06, wait: 0,
    color: COLORS.ok,
  }));

  // ---- HTML labels for key nodes ----
  const labels = [];
  if (labelLayer) {
    NODES.forEach((n, i) => {
      if (!n.show) return;
      const el = document.createElement('div');
      el.className = 'dag-label' + (n.kind === 'agent' ? ' blue' : '');
      el.textContent = n.label;
      labelLayer.appendChild(el);
      labels.push({ i, el, lit: 0 });
    });
  }

  // ---- interaction ----
  const mouse = new THREE.Vector2(0, 0);
  const target = new THREE.Vector2(0, 0);
  const onMove = (e) => {
    target.x = (e.clientX / window.innerWidth) * 2 - 1;
    target.y = -((e.clientY / window.innerHeight) * 2 - 1);
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  let reveal = 0;                              // 0..1 entrance
  const setReveal = (v) => { reveal = v; };

  const _ndc = new THREE.Vector3();
  let w = 1, h = 1;
  const { composer } = makeBloomComposer(renderer, scene, camera, canvas, {
    strength: isMobile ? 0.36 : 0.48, radius: 0.5, threshold: 0.5,
  });
  fitToCanvas(renderer, camera, canvas, (ww, hh) => { w = ww; h = hh; composer.setSize(ww, hh); });

  function update(dt, time) {
    mouse.lerp(target, 0.06);
    group.rotation.y = mouse.x * 0.32;
    group.rotation.x = -mouse.y * 0.2;

    // advance pulses + light nodes
    for (const pk of packets) {
      if (pk.wait > 0) { pk.wait -= dt; continue; }
      pk.t += dt * pk.speed;
      while (pk.t >= 1) {
        pk.t -= 1;
        pk.seg++;
        const arrived = pk.chain[Math.min(pk.seg, pk.chain.length - 1)];
        glow[arrived] = 1;                     // node flares as packet lands
        if (pk.seg >= pk.chain.length - 1) { pk.seg = 0; pk.wait = 0.6 + Math.random(); pk.t = 0; }
      }
    }

    // node positions: base + idle drift + cursor push
    for (let i = 0; i < N; i++) {
      const b = base[i];
      const driftX = Math.sin(time * 0.6 + i * 1.7) * 0.06;
      const driftY = Math.cos(time * 0.5 + i * 2.3) * 0.06;
      cur[i].set(b.x + driftX, b.y + driftY, b.z);

      // cursor repulsion in screen space
      _ndc.copy(cur[i]).applyMatrix4(group.matrixWorld).project(camera);
      const dx = _ndc.x - mouse.x, dy = _ndc.y - mouse.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 0.09) {
        const f = (1 - d2 / 0.09) * 0.5;
        cur[i].x += dx * f; cur[i].y += dy * f;
      }

      nPos[i * 3] = cur[i].x; nPos[i * 3 + 1] = cur[i].y; nPos[i * 3 + 2] = cur[i].z;

      glow[i] = Math.max(0, glow[i] - dt * 1.4);
      const g = glow[i];
      const c = baseColor[i];
      const lit = g * 1.4;
      nCol[i * 3] = Math.min(1, c.r * (0.86 + lit));
      nCol[i * 3 + 1] = Math.min(1, c.g * (0.86 + lit));
      nCol[i * 3 + 2] = Math.min(1, c.b * (0.86 + lit));
      nSize[i] = baseSize[i] * (1 + g * 1.2);
    }
    nodeGeo.attributes.position.needsUpdate = true;
    nodeGeo.attributes.aColor.needsUpdate = true;
    nodeGeo.attributes.aSize.needsUpdate = true;

    // edges follow nodes
    for (let e = 0; e < EDGES.length; e++) {
      const [a, b] = EDGES[e];
      const o = e * 6;
      ePos[o] = cur[a].x; ePos[o + 1] = cur[a].y; ePos[o + 2] = cur[a].z;
      ePos[o + 3] = cur[b].x; ePos[o + 4] = cur[b].y; ePos[o + 5] = cur[b].z;
      const ea = Math.max(glow[a], glow[b]);
      const col = COLORS.primaryDim;
      for (const k of [0, 3]) {
        eCol[o + k] = col.r * (0.45 + ea * 1.0);
        eCol[o + k + 1] = col.g * (0.45 + ea * 1.0);
        eCol[o + k + 2] = col.b * (0.45 + ea * 1.0);
      }
    }
    edgeGeo.attributes.position.needsUpdate = true;
    edgeGeo.attributes.color.needsUpdate = true;

    // pulse packet positions
    for (let p = 0; p < packets.length; p++) {
      const pk = packets[p];
      const aI = pk.chain[Math.min(pk.seg, pk.chain.length - 1)];
      const bI = pk.chain[Math.min(pk.seg + 1, pk.chain.length - 1)];
      const a = cur[aI], b = cur[bI];
      const t = pk.wait > 0 ? 0 : pk.t;
      pPos[p * 3] = a.x + (b.x - a.x) * t;
      pPos[p * 3 + 1] = a.y + (b.y - a.y) * t;
      pPos[p * 3 + 2] = a.z + (b.z - a.z) * t;
      pCol[p * 3] = pk.color.r; pCol[p * 3 + 1] = pk.color.g; pCol[p * 3 + 2] = pk.color.b;
      pSize[p] = pk.wait > 0 ? 0 : 0.9;
    }
    pulseGeo.attributes.position.needsUpdate = true;
    pulseGeo.attributes.aColor.needsUpdate = true;
    pulseGeo.attributes.aSize.needsUpdate = true;

    // reveal
    const r = reveal;
    nodeMat.uniforms.uOpacity.value = r;
    pulseMat.uniforms.uOpacity.value = r;
    edgeMat.opacity = r * 0.42;
    group.scale.setScalar(0.92 + r * 0.08);

    composer.render();

    // project labels (after render → matrixWorld current)
    if (labels.length) {
      for (const lab of labels) {
        _ndc.copy(cur[lab.i]).applyMatrix4(group.matrixWorld).project(camera);
        const x = (_ndc.x * 0.5 + 0.5) * w;
        const y = (-_ndc.y * 0.5 + 0.5) * h;
        const onscreen = _ndc.z < 1 && x > -40 && x < w + 40;
        lab.el.style.transform = `translate(${x}px, ${y - 26}px) translate(-50%, -50%)`;
        lab.el.style.opacity = onscreenOpacity(onscreen, r);
        const wantLit = glow[lab.i] > 0.25;
        if (wantLit !== lab.lit) { lab.el.classList.toggle('lit', wantLit); lab.lit = wantLit; }
      }
    }
  }

  function onscreenOpacity(onscreen, r) { return onscreen ? String(0.9 * r) : '0'; }

  const loop = createLoop(canvas, update);
  return { setReveal, start: loop.start, stop: loop.stop, renderOnce: loop.renderOnce };
}
