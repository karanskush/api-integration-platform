import * as THREE from 'three';
import {
  createRenderer, fitToCanvas, createLoop, dotTexture, makeBloomComposer, COLORS, isMobile,
} from './renderer.js';

/**
 * The pinned "7 layers" visual. A core dependency graph that progressively gains
 * structure as the section scrolls: state ring → failures → sandbox/prod fork →
 * webhook arcs → idempotency shields → cross-provider links. Driven by setProgress(0..1).
 */
export function createLayersScene(canvas) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 11);

  const renderer = createRenderer(canvas, { alpha: false });
  renderer.setClearColor(COLORS.bg, 1);

  const root = new THREE.Group();
  scene.add(root);
  const tex = dotTexture();

  // --- core graph layout ---
  const P = [
    [-3.6, 1.4, 0], [-1.2, 2.0, -0.6], [1.4, 1.6, 0.4], [3.4, 0.6, -0.4],
    [2.2, -1.4, 0.6], [-0.2, -1.9, -0.5], [-2.8, -1.0, 0.5], [0.6, 0.2, 0.2],
  ].map((p) => new THREE.Vector3(...p));
  const E = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 0], [1, 7], [7, 4], [7, 2]];

  const nodeGeo = new THREE.BufferGeometry().setAttribute('position',
    new THREE.BufferAttribute(new Float32Array(P.flatMap((v) => [v.x, v.y, v.z])), 3));
  const nodeMat = new THREE.PointsMaterial({ size: 0.42, map: tex, color: COLORS.primary, transparent: true, opacity: 0, depthWrite: false });
  root.add(new THREE.Points(nodeGeo, nodeMat));

  const eArr = [];
  E.forEach(([a, b]) => { eArr.push(P[a].x, P[a].y, P[a].z, P[b].x, P[b].y, P[b].z); });
  const edgeGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(eArr), 3));
  const edgeMat = new THREE.LineBasicMaterial({ color: COLORS.primaryDim, transparent: true, opacity: 0, depthWrite: false });
  root.add(new THREE.LineSegments(edgeGeo, edgeMat));

  // helper to make a circle line
  function ring(radius, segments, color) {
    const pts = [];
    for (let i = 0; i <= segments; i++) { const a = (i / segments) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0)); }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  }

  // feature groups, each with a progress range [start, end]
  const features = [];
  const addFeature = (obj, range) => { obj.userData.range = range; obj.userData.mats = []; obj.traverse((o) => { if (o.material) obj.userData.mats.push(o.material); }); root.add(obj); features.push(obj); };

  // 1. state ring around node 7 (the hub)
  const stateGroup = new THREE.Group();
  const sr = ring(1.1, 48, COLORS.primary); stateGroup.add(sr);
  const orbGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(5 * 3), 3));
  const orbMat = new THREE.PointsMaterial({ size: 0.28, map: tex, color: COLORS.primary, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const orbPoints = new THREE.Points(orbGeo, orbMat);
  stateGroup.add(orbPoints);
  stateGroup.position.copy(P[7]);
  addFeature(stateGroup, [0.12, 0.26]);

  // 2. failure markers (red points on a few nodes)
  const failIdx = [2, 4, 6];
  const failGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(failIdx.flatMap((i) => [P[i].x, P[i].y, P[i].z])), 3));
  const failMat = new THREE.PointsMaterial({ size: 0.7, map: tex, color: COLORS.danger, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  failMat.userData.blink = true;
  addFeature(new THREE.Points(failGeo, failMat), [0.28, 0.42]);

  // 3. sandbox/prod ghost fork (dim duplicate offset)
  const ghost = new THREE.Group();
  ghost.add(new THREE.Points(nodeGeo, new THREE.PointsMaterial({ size: 0.4, map: tex, color: COLORS.secondary, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })));
  ghost.add(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: COLORS.secondary, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })));
  ghost.position.set(0.8, -0.5, -2.2); ghost.scale.setScalar(0.92);
  addFeature(ghost, [0.42, 0.56]);

  // 4. webhook arcs (expanding rings near node 3)
  const arcs = new THREE.Group();
  [0.7, 1.1, 1.5].forEach((r) => arcs.add(ring(r, 40, COLORS.primary)));
  arcs.position.copy(P[3]);
  addFeature(arcs, [0.56, 0.7]);

  // 5. idempotency shields (rings around two nodes)
  const shields = new THREE.Group();
  [0, 5].forEach((i) => { const r = ring(0.85, 6, COLORS.primary); r.position.copy(P[i]); shields.add(r); });
  addFeature(shields, [0.7, 0.84]);

  // 6. cross-provider links (blue nodes + connectors)
  const cross = new THREE.Group();
  const xpos = [new THREE.Vector3(5.2, 1.6, -1), new THREE.Vector3(5.6, -1.2, 0.6), new THREE.Vector3(-5.2, -1.8, -0.8)];
  cross.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(xpos.flatMap((v) => [v.x, v.y, v.z])), 3)),
    new THREE.PointsMaterial({ size: 0.45, map: tex, color: COLORS.secondary, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })));
  const xl = []; xl.push(P[3].x, P[3].y, P[3].z, xpos[0].x, xpos[0].y, xpos[0].z); xl.push(P[4].x, P[4].y, P[4].z, xpos[1].x, xpos[1].y, xpos[1].z); xl.push(P[6].x, P[6].y, P[6].z, xpos[2].x, xpos[2].y, xpos[2].z);
  cross.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(xl), 3)),
    new THREE.LineBasicMaterial({ color: COLORS.secondary, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })));
  addFeature(cross, [0.84, 0.98]);

  let progress = 0;
  const setProgress = (p) => { progress = Math.max(0, Math.min(1, p)); };

  const { composer } = makeBloomComposer(renderer, scene, camera, canvas, { strength: isMobile ? 0.26 : 0.32, radius: 0.28, threshold: 0.52 });
  fitToCanvas(renderer, camera, canvas, (w, h) => composer.setSize(w, h));

  const clampRamp = (p, s, e) => Math.max(0, Math.min(1, (p - s) / (e - s)));

  function update(dt, time) {
    // base graph stays visible throughout the pin; features build on top
    const core = 0.5 + 0.45 * clampRamp(progress, 0, 0.12);
    nodeMat.opacity = core;
    edgeMat.opacity = core * 0.5;

    root.rotation.y = -0.3 + progress * 0.5 + Math.sin(time * 0.2) * 0.05;
    root.rotation.x = Math.sin(time * 0.15) * 0.04;

    // orbit points around the state hub
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2 + time * 0.6; const arr = orbGeo.attributes.position.array; arr[i * 3] = Math.cos(a) * 1.1; arr[i * 3 + 1] = Math.sin(a) * 1.1; arr[i * 3 + 2] = 0; }
    orbGeo.attributes.position.needsUpdate = true;

    for (const f of features) {
      const [s, e] = f.userData.range;
      const local = clampRamp(progress, s, e);
      const op = local;
      for (const m of f.userData.mats) m.opacity = op * (m.userData.blink ? (0.6 + 0.4 * Math.sin(time * 6)) : 0.9);
      f.scale.setScalar(0.85 + local * 0.15);
    }
    // expanding webhook arcs
    arcs.children.forEach((a, i) => { const s = 0.6 + ((time * 0.4 + i * 0.33) % 1) * 1.2; a.scale.setScalar(s); a.material.opacity *= (1 - ((time * 0.4 + i * 0.33) % 1)); });

    composer.render();
  }

  const loop = createLoop(canvas, update);
  return { setProgress, start: loop.start, stop: loop.stop, renderOnce: loop.renderOnce };
}
