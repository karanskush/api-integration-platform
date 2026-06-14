import * as THREE from 'three';
import {
  createRenderer, fitToCanvas, createLoop, dotTexture, makeBloomComposer, COLORS, isMobile,
} from './renderer.js';

/**
 * The Problem-section "drift" visual. A clean ordered lattice (the spec / the map)
 * that fractures and drifts into chaos as the section scrolls — connector lines tear,
 * a seeded subset of nodes flare red (the undocumented divergence / errors).
 * Driven by setProgress(0..1) from a scroll scrub. The map literally pulls apart.
 */
export function createDriftScene(canvas) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.set(0, 0, 9.2);

  const renderer = createRenderer(canvas, { alpha: false });
  renderer.setClearColor(COLORS.bg, 1);

  const group = new THREE.Group();
  scene.add(group);
  const tex = dotTexture();

  // deterministic per-index hash so the field is identical every run (no Math.random in loop)
  const rand = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  // --- lattice layout ---
  const COLS = isMobile ? 14 : 24;
  const ROWS = isMobile ? 8 : 13;
  const N = COLS * ROWS;
  const SPAN_X = 17.5, SPAN_Y = 9.4;

  const base = new Array(N);
  const offset = new Array(N);   // drift target direction * magnitude
  const isErr = new Uint8Array(N);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      const x = -SPAN_X / 2 + (c / (COLS - 1)) * SPAN_X;
      const y = -SPAN_Y / 2 + (r / (ROWS - 1)) * SPAN_Y;
      const z = (rand(i + 5) - 0.5) * 0.6;
      base[i] = new THREE.Vector3(x, y, z);
      const err = rand(i + 7) > 0.87;
      isErr[i] = err ? 1 : 0;
      const ang = rand(i) * Math.PI * 2;
      const mag = (err ? 1.8 : 0.9) + rand(i + 1) * (err ? 2.4 : 1.8);
      offset[i] = new THREE.Vector3(
        Math.cos(ang) * mag,
        Math.sin(ang) * mag,
        (rand(i + 2) - 0.5) * 3.4,
      );
    }
  }

  // ---- per-point shader (size + color), mirrors DagScene ----
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

  // error nodes get a second additive pass so they read as hot flares
  const errIdx = [];
  for (let i = 0; i < N; i++) if (isErr[i]) errIdx.push(i);
  const errGeo = new THREE.BufferGeometry();
  const ePos = new Float32Array(errIdx.length * 3);
  const eCol = new Float32Array(errIdx.length * 3);
  const eSize = new Float32Array(errIdx.length);
  errGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
  errGeo.setAttribute('aColor', new THREE.BufferAttribute(eCol, 3));
  errGeo.setAttribute('aSize', new THREE.BufferAttribute(eSize, 1));
  const errMat = pointMat(0, THREE.AdditiveBlending);
  const errPoints = new THREE.Points(errGeo, errMat);
  errPoints.frustumCulled = false;
  group.add(errPoints);

  // ---- connector lines (the structured "map" — neighbor links) ----
  const links = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (c < COLS - 1) links.push([i, i + 1]);
      if (r < ROWS - 1) links.push([i, i + COLS]);
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  const lPos = new Float32Array(links.length * 2 * 3);
  lineGeo.setAttribute('position', new THREE.BufferAttribute(lPos, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: COLORS.beigeDim, transparent: true, opacity: 0, depthWrite: false });
  const lineSeg = new THREE.LineSegments(lineGeo, lineMat);
  lineSeg.frustumCulled = false;
  group.add(lineSeg);

  // ---- interaction (parallax) ----
  const mouse = new THREE.Vector2(0, 0);
  const targetM = new THREE.Vector2(0, 0);
  const onMove = (e) => {
    targetM.x = (e.clientX / window.innerWidth) * 2 - 1;
    targetM.y = -((e.clientY / window.innerHeight) * 2 - 1);
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  let progress = 0, shown = 0;
  const setProgress = (p) => { progress = Math.max(0, Math.min(1, p)); };

  const { composer } = makeBloomComposer(renderer, scene, camera, canvas, {
    strength: isMobile ? 0.32 : 0.42, radius: 0.34, threshold: 0.5,
  });
  fitToCanvas(renderer, camera, canvas, (w, h) => composer.setSize(w, h));

  const cur = base.map((v) => v.clone());
  const smooth = (t) => t * t * (3 - 2 * t);

  function update(dt, time) {
    shown += (1 - shown) * Math.min(1, dt * 1.4);
    mouse.lerp(targetM, 0.05);
    group.rotation.y = mouse.x * 0.16;
    group.rotation.x = -mouse.y * 0.1;

    const drift = smooth(progress);
    let ePtr = 0;

    for (let i = 0; i < N; i++) {
      const b = base[i], o = offset[i];
      // idle breathing keeps it alive even at rest
      const wob = Math.sin(time * 0.5 + i * 0.7) * 0.05;
      cur[i].set(
        b.x + o.x * drift + wob,
        b.y + o.y * drift + Math.cos(time * 0.45 + i * 1.1) * 0.05,
        b.z + o.z * drift,
      );
      nPos[i * 3] = cur[i].x; nPos[i * 3 + 1] = cur[i].y; nPos[i * 3 + 2] = cur[i].z;

      if (isErr[i]) {
        // beige → red as the map drifts, with a hot blink
        const blink = 0.6 + 0.4 * Math.sin(time * 5 + i);
        const heat = Math.min(1, 0.25 + drift * 1.1);
        const cr = THREE.MathUtils.lerp(COLORS.beige.r, COLORS.red.r, heat);
        const cg = THREE.MathUtils.lerp(COLORS.beige.g, COLORS.red.g, heat);
        const cb = THREE.MathUtils.lerp(COLORS.beige.b, COLORS.red.b, heat);
        nCol[i * 3] = cr; nCol[i * 3 + 1] = cg; nCol[i * 3 + 2] = cb;
        nSize[i] = 0.6 + drift * 0.5;
        // additive flare pass
        ePos[ePtr * 3] = cur[i].x; ePos[ePtr * 3 + 1] = cur[i].y; ePos[ePtr * 3 + 2] = cur[i].z;
        const f = (0.2 + drift) * blink;
        eCol[ePtr * 3] = COLORS.red.r * f; eCol[ePtr * 3 + 1] = COLORS.red.g * f; eCol[ePtr * 3 + 2] = COLORS.red.b * f;
        eSize[ePtr] = 1.1 + drift * 0.9;
        ePtr++;
      } else {
        // ordered nodes dim slightly as structure is lost
        const lum = 0.85 - drift * 0.35;
        nCol[i * 3] = COLORS.beige.r * lum;
        nCol[i * 3 + 1] = COLORS.beige.g * lum;
        nCol[i * 3 + 2] = COLORS.beige.b * lum;
        nSize[i] = 0.42;
      }
    }
    nodeGeo.attributes.position.needsUpdate = true;
    nodeGeo.attributes.aColor.needsUpdate = true;
    nodeGeo.attributes.aSize.needsUpdate = true;
    errGeo.attributes.position.needsUpdate = true;
    errGeo.attributes.aColor.needsUpdate = true;
    errGeo.attributes.aSize.needsUpdate = true;

    // connector lines follow nodes and fade as the lattice tears apart
    for (let k = 0; k < links.length; k++) {
      const [a, b] = links[k];
      const off = k * 6;
      lPos[off] = cur[a].x; lPos[off + 1] = cur[a].y; lPos[off + 2] = cur[a].z;
      lPos[off + 3] = cur[b].x; lPos[off + 4] = cur[b].y; lPos[off + 5] = cur[b].z;
    }
    lineGeo.attributes.position.needsUpdate = true;
    lineMat.opacity = shown * (0.5 - drift * 0.42);

    nodeMat.uniforms.uOpacity.value = shown;
    errMat.uniforms.uOpacity.value = shown;

    composer.render();
  }

  const loop = createLoop(canvas, update);
  return { setProgress, start: loop.start, stop: loop.stop, renderOnce: loop.renderOnce };
}
