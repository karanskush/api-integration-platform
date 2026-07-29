'use client';

import { useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import Stage from '../Stage';
import { isLowPower } from '../env';
import { CHANNEL, IRIDIUM, earned } from '../palette';
import type { SceneProps } from '../types';
import { clamp01, damp, ease } from '../useChapter';

// CHAPTER 1 — "A spec is a claim. We go and check."
//
// Three movements, because the sentence has three parts:
//
//   1. CRYSTALLISE — a pasted document arrives as scattered noise and collapses
//      into a lattice of typed tools. Import. Every cell settles the same dim
//      violet, because at this point every cell is only a claim.
//   2. THE PROBE — a scan-line sweeps the lattice left to right. Each cell it
//      reaches pops, flashes, and settles brighter: checked. Five settle amber
//      instead — the normalizer really does classify DELETE and money-movement
//      operations as destructive and really does withhold them from MCP. The
//      amber appears when the probe reaches them, not before, because finding
//      out by checking is the product.
//   3. TRAFFIC — behind the front, packets start running the wires: verified
//      tools taking agent calls. The probe re-runs every few seconds, quieter —
//      re-issued whenever the spec changes.
//
// The lime flash is the page's earned colour and appears only at the instant a
// cell passes its probe, via earned() — never as ambient decoration.

const COLS = 9;
const ROWS = 5;
const LAYERS = 3;
const COUNT = COLS * ROWS * LAYERS;
const GAP = 0.7;
/**
 * Deeper than GAP on purpose. At the hero's yaw, layers spaced like columns
 * project on top of each other and merge into horizontal bars; air between
 * layers is what makes the lattice read as a volume instead of a wall.
 */
const GAP_Z = 1.05;

/** Indices that settle as "unsafe op flagged". Fixed, not random. */
const FLAGGED = new Set([13, 40, 71, 96, 118]);

const CRYSTALLISE_MS = 2200;
/** Seconds. The first sweep waits for the last cell to land, then a beat. */
const SWEEP_START = 3.6;
const SWEEP_SECS = 3.4;
const SWEEP_PERIOD = 9;
/** Width of the probe's glow falloff, world units. */
const FRONT_SIGMA = 0.55;

const HALF_X = ((COLS - 1) * GAP) / 2;
const HALF_Y = ((ROWS - 1) * GAP) / 2;
const HALF_Z = ((LAYERS - 1) * GAP_Z) / 2;
const FRONT_LEFT = -HALF_X - 1.1;
const FRONT_RIGHT = HALF_X + 1.1;

const LIME_FLASH = new THREE.Color(earned('read-safe probe matched the documented shape'));
const AMBER_FLASH = new THREE.Color(IRIDIUM.drift);
const IRIS = new THREE.Color(IRIDIUM.iris);

const tmpColour = new THREE.Color();
const tmpVec = new THREE.Vector3();

/**
 * Deterministic pseudo-random: the scene must look identical on every load,
 * and Math.random() would also make the wave order differ between the two
 * canvases a fast scroll can briefly have alive at once.
 */
function makeRand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

type Cell = {
  target: THREE.Vector3;
  origin: THREE.Vector3;
  delay: number;
  spin: number;
  flagged: boolean;
  /** Before its probe: a claim. Dim violet, dimmer still in the back layers. */
  claim: THREE.Color;
  /** After its probe: brighter violet, or amber if the op was flagged. */
  settled: THREE.Color;
  /** Seconds-clock timestamp of the moment the probe reached it. -1 = not yet. */
  checkedAt: number;
};

function buildCells(): Cell[] {
  const rand = makeRand(0x5c0f);
  const cells: Cell[] = [];

  for (let i = 0; i < COUNT; i += 1) {
    const x = i % COLS;
    const y = Math.floor(i / COLS) % ROWS;
    const z = Math.floor(i / (COLS * ROWS));

    // Back layers are dimmer. Flat colour at three depths is what made the
    // old build read as wallpaper; this one cue does most of the volume work.
    const depth = 0.55 + 0.45 * (z / (LAYERS - 1));
    const flagged = FLAGGED.has(i);

    // Origin: a loose shell well outside the lattice, so the collapse reads
    // as "scattered claims pulled into order" rather than a fade-in.
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    const radius = 7 + rand() * 5;

    cells.push({
      target: new THREE.Vector3(x * GAP - HALF_X, y * GAP - HALF_Y, z * GAP_Z - HALF_Z),
      origin: new THREE.Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta) * 0.6,
        radius * Math.cos(phi),
      ),
      // A wave that sweeps left to right, so the lattice assembles in reading
      // order rather than popping into existence all at once.
      delay: (x / COLS) * 0.42 + rand() * 0.16,
      spin: rand() * Math.PI,
      flagged,
      claim: new THREE.Color(IRIDIUM.iris).multiplyScalar(0.5 * depth),
      settled: flagged
        ? new THREE.Color(IRIDIUM.drift).multiplyScalar(1.05 * depth)
        : new THREE.Color(IRIDIUM.iris2).multiplyScalar(0.95 * depth),
      checkedAt: -1,
    });
  }
  return cells;
}

type Wires = {
  geometry: THREE.BufferGeometry;
  /** One x-coordinate per vertex, so the probe can light wires near its front. */
  vertexX: Float32Array;
  /** Cell-index pairs, one per edge — the graph the packets walk. */
  edges: Array<[number, number]>;
  /** Cell index → indices into `edges`. */
  adjacency: number[][];
};

/** Lattice edges along X and Y — the wiring that appears once cells settle. */
function buildWires(cells: Cell[]): Wires {
  const positions: number[] = [];
  const edges: Array<[number, number]> = [];
  const adjacency: number[][] = Array.from({ length: COUNT }, () => []);
  const idx = (x: number, y: number, z: number) => z * COLS * ROWS + y * COLS + x;

  const push = (a: number, b: number) => {
    positions.push(...cells[a].target.toArray(), ...cells[b].target.toArray());
    adjacency[a].push(edges.length);
    adjacency[b].push(edges.length);
    edges.push([a, b]);
  };

  for (let z = 0; z < LAYERS; z += 1) {
    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        if (x < COLS - 1) push(idx(x, y, z), idx(x + 1, y, z));
        if (y < ROWS - 1) push(idx(x, y, z), idx(x, y + 1, z));
      }
    }
  }

  const vertexX = new Float32Array(positions.length / 3);
  for (let v = 0; v < vertexX.length; v += 1) vertexX[v] = positions[v * 3];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // Starts black — with additive blending, black is invisible, so the wiring
  // literally cannot render before the frame loop decides it may.
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3));
  return { geometry, vertexX, edges, adjacency };
}

type Packet = {
  edge: number;
  /** Cell index the packet is travelling *from* — fixes direction on the edge. */
  from: number;
  t: number;
  speed: number;
  /** Damped visibility — packets only exist behind the verification front. */
  vis: number;
};

function buildPackets(count: number, wires: Wires): Packet[] {
  const rand = makeRand(0xbeef);
  return Array.from({ length: count }, () => {
    const edge = Math.floor(rand() * wires.edges.length);
    return {
      edge,
      from: wires.edges[edge][rand() > 0.5 ? 0 : 1],
      t: rand(),
      speed: (0.55 + rand() * 0.5) / GAP, // world-units/s → t/s on a GAP-long edge
      vis: 0,
    };
  });
}

function Lattice({
  progress,
  packetCount,
}: {
  progress: SceneProps['progress'];
  packetCount: number;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const wireRef = useRef<THREE.LineSegments>(null);
  const packRef = useRef<THREE.InstancedMesh>(null);
  const scanRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);

  const elapsed = useRef(0);
  const tilt = useRef(0);
  const ptrX = useRef(0);
  const ptrY = useRef(0);
  /** Rightmost x the first sweep has verified — the packets' leash. */
  const frontMax = useRef(-Infinity);
  const walkRand = useRef(makeRand(0xf00d));

  const cells = useMemo(buildCells, []);
  const wires = useMemo(() => buildWires(cells), [cells]);
  const packets = useMemo(() => buildPackets(packetCount, wires), [packetCount, wires]);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const packetColour = useMemo(() => new THREE.Color(CHANNEL.agent).multiplyScalar(1.7), []);

  // Seed the claim colours before first paint. setColorAt rather than a
  // hand-attached instanceColor attribute plus `vertexColors` on the material:
  // that combination looks equivalent and is not — `vertexColors` defines
  // USE_COLOR, which makes the shader read a per-vertex `color` attribute that
  // boxGeometry does not have, so every instance renders black.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    cells.forEach((cell, i) => mesh.setColorAt(i, cell.claim));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [cells]);

  useFrame((state, rawDelta) => {
    const mesh = meshRef.current;
    const group = groupRef.current;
    if (!mesh || !group) return;

    // A backgrounded tab hands back a giant delta on return; clamping keeps
    // the timeline from teleporting mid-sweep.
    const delta = Math.min(rawDelta, 0.1);
    elapsed.current += delta;
    const now = elapsed.current;
    const totalMs = now * 1000;

    // ---- where the probe is -------------------------------------------------
    const sweepT = now - SWEEP_START;
    const sweepIndex = sweepT >= 0 ? Math.floor(sweepT / SWEEP_PERIOD) : -1;
    const local = sweepIndex >= 0 ? sweepT - sweepIndex * SWEEP_PERIOD : 0;
    const sweeping = sweepIndex >= 0 && local <= SWEEP_SECS;
    const fx = sweeping
      ? FRONT_LEFT + (FRONT_RIGHT - FRONT_LEFT) * ease(local / SWEEP_SECS)
      : FRONT_LEFT;
    // The first pass is the event; re-verifications are routine and look it.
    const strength = sweepIndex === 0 ? 1 : 0.45;

    if (sweeping && sweepIndex === 0) {
      frontMax.current = Math.max(frontMax.current, fx);
    } else if (sweepIndex >= 0 && (sweepIndex > 0 || local > SWEEP_SECS)) {
      frontMax.current = Infinity;
    }

    // ---- cells --------------------------------------------------------------
    for (let i = 0; i < COUNT; i += 1) {
      const cell = cells[i];
      const t = ease(clamp01((totalMs - cell.delay * CRYSTALLISE_MS) / CRYSTALLISE_MS));

      // The probe reaches a cell the moment the front passes its column. If a
      // throttled tab skips the whole sweep, settle the stragglers silently.
      if (cell.checkedAt < 0) {
        if (sweeping && fx > cell.target.x) cell.checkedAt = now;
        else if (sweepIndex >= 0 && !sweeping) cell.checkedAt = now - 3;
      }
      const checked = cell.checkedAt >= 0;
      const flash = checked ? Math.exp(-(now - cell.checkedAt) * 3.2) : 0;

      dummy.position.lerpVectors(cell.origin, cell.target, t);
      // Settled cells breathe very slightly, so the lattice stays alive
      // without ever looking like it is still resolving.
      dummy.position.y += Math.sin(now * 0.9 + cell.spin) * 0.02 * t;

      let scale = (0.05 + 0.11 * t) * (1 + 0.5 * flash);
      if (cell.flagged && checked) {
        // Flagged ops keep asking for attention — a slow amber pulse, not a blink.
        scale *= 1 + 0.05 * Math.sin(now * 2.4 + cell.spin * 7);
      }
      dummy.scale.setScalar(scale);
      // Scattered cells tumble; settled cells are square to the grid. The
      // rotation resolving *to zero* is what sells "normalised".
      dummy.rotation.set(cell.spin * (1 - t) * 2, cell.spin * (1 - t) * 3, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Colour: claim → (flash of the verdict) → settled verdict. The glow
      // gaussian rides the front so light precedes judgement by half a beat.
      const dx = fx - cell.target.x;
      const boost = sweeping
        ? Math.exp(-(dx * dx) / (2 * FRONT_SIGMA * FRONT_SIGMA)) * strength
        : 0;
      tmpColour.copy(checked ? cell.settled : cell.claim);
      if (flash > 0.01) tmpColour.lerp(cell.flagged ? AMBER_FLASH : LIME_FLASH, Math.min(1, flash));
      // >1 on purpose: toneMapped is off, so the overshoot is what bloom eats.
      tmpColour.multiplyScalar((0.35 + 0.65 * t) * (1 + boost * 0.9 + flash * 1.8));
      mesh.setColorAt(i, tmpColour);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    // ---- wires --------------------------------------------------------------
    // Fade in behind the last cells to land — you cannot draw the dependency
    // edges until you know where the operations are. Near the front they
    // ignite: the probe travels *on the wiring*, not past it.
    const wire = wireRef.current;
    if (wire) {
      const colours = wire.geometry.getAttribute('color') as THREE.BufferAttribute;
      const arr = colours.array as Float32Array;
      const base = clamp01((totalMs - CRYSTALLISE_MS * 0.75) / 900) * 0.32;
      for (let v = 0; v < wires.vertexX.length; v += 1) {
        const dvx = fx - wires.vertexX[v];
        const glow = sweeping
          ? Math.exp(-(dvx * dvx) / (2 * FRONT_SIGMA * FRONT_SIGMA)) * 0.9 * strength
          : 0;
        const k = base + glow;
        arr[v * 3] = IRIS.r * k;
        arr[v * 3 + 1] = IRIS.g * k;
        arr[v * 3 + 2] = IRIS.b * k;
      }
      colours.needsUpdate = true;
    }

    // ---- packets ------------------------------------------------------------
    const pack = packRef.current;
    if (pack) {
      const rand = walkRand.current;
      for (let i = 0; i < packets.length; i += 1) {
        const p = packets[i];
        p.t += p.speed * delta;
        while (p.t >= 1) {
          p.t -= 1;
          const [a, b] = wires.edges[p.edge];
          const arrived = p.from === a ? b : a;
          const options = wires.adjacency[arrived];
          let next = options[Math.floor(rand() * options.length)];
          // Don't immediately walk back the way we came unless cornered.
          if (next === p.edge && options.length > 1) {
            next = options[(options.indexOf(next) + 1) % options.length];
          }
          p.edge = next;
          p.from = arrived;
        }
        const [a, b] = wires.edges[p.edge];
        const to = p.from === a ? b : a;
        tmpVec.lerpVectors(cells[p.from].target, cells[to].target, p.t);

        // A packet may only run wiring the probe has already cleared.
        const live = tmpVec.x < frontMax.current - 0.2;
        p.vis = damp(p.vis, live ? 1 : 0, 6, delta);

        dummy.position.copy(tmpVec);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(0.045 * p.vis + 0.0001);
        dummy.updateMatrix();
        pack.setMatrixAt(i, dummy.matrix);
      }
      pack.instanceMatrix.needsUpdate = true;
    }

    // ---- the scan-line itself ----------------------------------------------
    const scan = scanRef.current;
    if (scan) {
      const ramp = sweeping
        ? clamp01(local / 0.4) * clamp01((SWEEP_SECS - local) / 0.4)
        : 0;
      const material = scan.material as THREE.MeshBasicMaterial;
      material.opacity = 0.13 * strength * ramp;
      scan.visible = material.opacity > 0.004;
      scan.position.x = fx;
    }

    // ---- camera-space drift -------------------------------------------------
    // Scroll pushes the lattice back and tips it away as the chapter leaves;
    // the pointer leans it a few degrees toward the reader's attention.
    const p = progress.current;
    tilt.current = damp(tilt.current, p, 3, delta);
    ptrX.current = damp(ptrX.current, state.pointer.x, 3, delta);
    ptrY.current = damp(ptrY.current, state.pointer.y, 3, delta);
    group.rotation.y = 0.3 + Math.sin(now * 0.1) * 0.1 + tilt.current * 0.5 + ptrX.current * 0.07;
    group.rotation.x = -0.16 + tilt.current * 0.34 - ptrY.current * 0.05;
    group.position.z = -tilt.current * 3.2;
    group.position.y = tilt.current * 0.9;
  });

  return (
    <group ref={groupRef}>
      <instancedMesh ref={meshRef} args={[undefined, undefined, COUNT]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      <lineSegments ref={wireRef} geometry={wires.geometry} frustumCulled={false}>
        <lineBasicMaterial
          vertexColors
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </lineSegments>

      <instancedMesh ref={packRef} args={[undefined, undefined, packets.length]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 10]} />
        <meshBasicMaterial
          color={packetColour}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </instancedMesh>

      <mesh ref={scanRef} visible={false}>
        <boxGeometry args={[0.05, ROWS * GAP + 1.2, (LAYERS - 1) * GAP_Z + 1.2]} />
        <meshBasicMaterial
          color={IRIDIUM.iris2}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

export default function SpecLattice({ active, progress }: SceneProps) {
  // The reduced build a low-power device gets instead of a slideshow: fewer
  // packets and no composer pass. Referenced from env.ts's canRender3D note.
  const budget = isLowPower() ? { packets: 10, bloom: false } : { packets: 26, bloom: true };

  return (
    <Stage active={active} camera={{ fov: 44 }} fit={{ width: 6.8, height: 4.2 }}>
      <Lattice progress={progress} packetCount={budget.packets} />
      {/* One of the page's two sanctioned glows. Bloom is what turns the HDR
          overshoot on flashes, front and packets into light rather than
          clipped white — and it is also the single most expensive thing here,
          so a low-power device gets the lattice without it. */}
      {budget.bloom && (
        <EffectComposer enableNormalPass={false}>
          <Bloom intensity={0.72} luminanceThreshold={0.16} luminanceSmoothing={0.4} mipmapBlur />
        </EffectComposer>
      )}
    </Stage>
  );
}
