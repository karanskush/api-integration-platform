'use client';

import { useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import Stage from '../Stage';
import { isLowPower } from '../env';
import { IRIDIUM } from '../palette';
import type { SceneProps } from '../types';
import { clamp01, damp, ease } from '../useChapter';

// CHAPTER 1 — "A spec is a claim. We go and check."
//
// A pasted document arrives as noise and crystallises into a lattice of typed
// tools, wired to each other. That is literally what the importer does: 42
// endpoints in, 38 normalised tools out, unsafe ops flagged.
//
// The flagged nodes are the reason this is not decoration. Four of the
// crystallised cells settle amber rather than violet, because the normalizer
// really does classify DELETE and money-movement operations as destructive and
// really does withhold them from MCP by default. A lattice where every cell
// resolved the same colour would be a prettier scene and a false one.

const COLS = 9;
const ROWS = 5;
const LAYERS = 3;
const COUNT = COLS * ROWS * LAYERS;
const GAP = 0.66;

/** Indices that settle as "unsafe op flagged". Fixed, not random — see above. */
const FLAGGED = new Set([13, 40, 71, 96, 118]);

const CRYSTALLISE_MS = 2600;

type Cell = {
  target: THREE.Vector3;
  origin: THREE.Vector3;
  delay: number;
  spin: number;
  colour: THREE.Color;
};

function buildCells(): Cell[] {
  // Deterministic pseudo-random: the scene must look identical on every load,
  // and Math.random() would also make the wave order differ between the two
  // canvases a fast scroll can briefly have alive at once.
  let seed = 0x5c0f;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const cells: Cell[] = [];
  const halfX = ((COLS - 1) * GAP) / 2;
  const halfY = ((ROWS - 1) * GAP) / 2;
  const halfZ = ((LAYERS - 1) * GAP) / 2;

  for (let i = 0; i < COUNT; i += 1) {
    const x = i % COLS;
    const y = Math.floor(i / COLS) % ROWS;
    const z = Math.floor(i / (COLS * ROWS));

    // Origin: a loose shell well outside the lattice, so the collapse reads
    // as "scattered claims pulled into order" rather than a fade-in.
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    const radius = 7 + rand() * 5;

    cells.push({
      target: new THREE.Vector3(x * GAP - halfX, y * GAP - halfY, z * GAP - halfZ),
      origin: new THREE.Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta) * 0.6,
        radius * Math.cos(phi),
      ),
      // A wave that sweeps left to right, so the lattice assembles in reading
      // order rather than popping into existence all at once.
      delay: (x / COLS) * 0.42 + rand() * 0.16,
      spin: rand() * Math.PI,
      colour: new THREE.Color(FLAGGED.has(i) ? IRIDIUM.drift : IRIDIUM.iris),
    });
  }
  return cells;
}

/** Lattice edges along X and Y — the wiring that appears once cells settle. */
function buildWireGeometry(cells: Cell[]): THREE.BufferGeometry {
  const points: number[] = [];
  const at = (x: number, y: number, z: number) => cells[z * COLS * ROWS + y * COLS + x].target;

  for (let z = 0; z < LAYERS; z += 1) {
    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        if (x < COLS - 1) points.push(...at(x, y, z).toArray(), ...at(x + 1, y, z).toArray());
        if (y < ROWS - 1) points.push(...at(x, y, z).toArray(), ...at(x, y + 1, z).toArray());
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return geometry;
}

function Lattice({ progress }: { progress: SceneProps['progress'] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const wireRef = useRef<THREE.LineSegments>(null);
  const groupRef = useRef<THREE.Group>(null);
  const elapsed = useRef(0);
  const tilt = useRef(0);

  const cells = useMemo(buildCells, []);
  const wireGeometry = useMemo(() => buildWireGeometry(cells), [cells]);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // Set once: a cell's classification does not change, and rewriting 135
  // colours every frame to say so would be pure heat.
  //
  // Via setColorAt rather than a hand-attached instanceColor attribute plus
  // `vertexColors` on the material. That combination looks equivalent and is
  // not: `vertexColors` defines USE_COLOR, which makes the shader read a
  // per-vertex `color` attribute that boxGeometry does not have — so every
  // instance multiplies by an undefined attribute and renders black.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    cells.forEach((cell, i) => mesh.setColorAt(i, cell.colour));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [cells]);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    const group = groupRef.current;
    if (!mesh || !group) return;

    elapsed.current += delta;
    const total = elapsed.current * 1000;

    for (let i = 0; i < COUNT; i += 1) {
      const cell = cells[i];
      const t = ease(clamp01((total - cell.delay * CRYSTALLISE_MS) / CRYSTALLISE_MS));

      dummy.position.lerpVectors(cell.origin, cell.target, t);
      // Settled cells breathe very slightly, so the lattice stays alive
      // without ever looking like it is still resolving.
      const breathe = Math.sin(elapsed.current * 0.9 + cell.spin) * 0.02 * t;
      dummy.position.y += breathe;

      const scale = 0.06 + 0.09 * t;
      dummy.scale.setScalar(scale);
      // Scattered cells tumble; settled cells are square to the grid. The
      // rotation resolving *to zero* is what sells "normalised".
      dummy.rotation.set(cell.spin * (1 - t) * 2, cell.spin * (1 - t) * 3, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;

    // Wiring fades in behind the last cells to land — you cannot draw the
    // dependency edges until you know where the operations are.
    const wire = wireRef.current;
    if (wire) {
      const material = wire.material as THREE.LineBasicMaterial;
      material.opacity = clamp01((total - CRYSTALLISE_MS * 0.75) / 900) * 0.2;
    }

    // Scroll pushes the lattice back and tips it away as the chapter leaves.
    const p = progress.current;
    tilt.current = damp(tilt.current, p, 3, delta);
    group.rotation.y = Math.sin(elapsed.current * 0.12) * 0.24 + tilt.current * 0.5;
    group.rotation.x = -0.12 + tilt.current * 0.34;
    group.position.z = -tilt.current * 3.2;
    group.position.y = tilt.current * 0.9;
  });

  return (
    <group ref={groupRef}>
      <instancedMesh ref={meshRef} args={[undefined, undefined, COUNT]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      <lineSegments ref={wireRef} geometry={wireGeometry}>
        <lineBasicMaterial
          color={IRIDIUM.iris}
          transparent
          opacity={0}
          toneMapped={false}
          depthWrite={false}
        />
      </lineSegments>
    </group>
  );
}

export default function SpecLattice({ active, progress }: SceneProps) {
  const lean = isLowPower();

  return (
    <Stage active={active} camera={{ fov: 44 }} fit={{ width: 6.8, height: 4.2 }}>
      <Lattice progress={progress} />
      {/* One of the page's two sanctioned glows. Bloom is what makes an
          additive lattice read as light rather than as plastic — but it is
          also the single most expensive thing here, so a low-power device
          gets the lattice without it rather than a slideshow with it. */}
      {!lean && (
        <EffectComposer enableNormalPass={false}>
          <Bloom intensity={0.62} luminanceThreshold={0.18} luminanceSmoothing={0.4} mipmapBlur />
        </EffectComposer>
      )}
    </Stage>
  );
}
