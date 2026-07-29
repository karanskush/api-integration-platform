'use client';

import { useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import Label from '../Label';
import Stage from '../Stage';
import { isLowPower } from '../env';
import { IRIDIUM, earned } from '../palette';
import type { SceneProps } from '../types';
import { clamp01, ease, remap } from '../useChapter';

// CHAPTER 7 — the Agent-Ready Score, as an instrument.
//
// The outer ring is the honest part. Four arcs, one per sub-score, and their
// colour is not a style choice: `errorQuality` and `docDrift` are the two that
// issue live requests (src/lib/probes/), so they are the only two allowed to
// be --verified. `authClarity` grades a declared scheme and `idempotency`
// greps parameter names — both are read off the document, so both are drawn in
// the instrument channel instead. The page says which is which in words; this
// says it in pigment, and the two must not disagree.
//
// The needle overshoots and damps back rather than easing to rest, because
// that is what a real instrument does when it takes a reading. Motion here
// demonstrates measurement; it does not decorate.

const TARGET = 87;

const SUBSCORES = [
  { name: 'error quality', value: 78, live: true },
  { name: 'doc drift', value: 84, live: true },
  { name: 'auth clarity', value: 92, live: false },
  { name: 'idempotency', value: 95, live: false },
];

const ARC_RADIUS = 1.28;
const ARC_TUBE = 0.075;
const OUTER_RADIUS = 1.72;
const OUTER_TUBE = 0.032;
const TUBULAR = 128;
const RADIAL = 10;

/** Indices per step around the sweep — the unit drawRange advances in. */
const INDICES_PER_STEP = RADIAL * 6;

const TOP = Math.PI / 2;
/** Sweep steps in one sub-score quadrant. */
const SUB_STEPS = 32;

/**
 * A tube swept along an arc, indexed **sweep-major**.
 *
 * three's own TorusGeometry cannot be used here. Its index buffer is built
 * radial-major (outer loop over the tube's cross-section, inner loop around
 * the ring), so growing drawRange adds thickness all the way around the full
 * circle instead of extending the arc — a gauge that reads 33 while showing a
 * nearly complete ring. Ordering the indices by sweep step instead makes
 * drawRange do exactly what a filling gauge needs, with no per-frame geometry
 * rebuild.
 *
 * `sweep` is negative for a clockwise fill, which is the direction every
 * physical instrument reads.
 */
function arcTube(radius: number, tube: number, start: number, sweep: number, steps: number) {
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const u = start + (i / steps) * sweep;
    for (let j = 0; j <= RADIAL; j += 1) {
      const v = (j / RADIAL) * Math.PI * 2;
      const r = radius + tube * Math.cos(v);
      positions.push(r * Math.cos(u), r * Math.sin(u), tube * Math.sin(v));
    }
  }

  const stride = RADIAL + 1;
  for (let i = 1; i <= steps; i += 1) {
    for (let j = 1; j <= RADIAL; j += 1) {
      const a = (i - 1) * stride + (j - 1);
      const b = i * stride + (j - 1);
      const c = i * stride + j;
      const d = (i - 1) * stride + j;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.setDrawRange(0, 0);
  return geometry;
}

/** The 0–100 calibration ruler: a tick every unit, a long one every ten. */
function tickGeometry(): THREE.BufferGeometry {
  const vertices: number[] = [];
  for (let i = 0; i <= 100; i += 1) {
    const angle = (i / 100) * Math.PI * 2 - Math.PI / 2;
    const major = i % 10 === 0;
    const inner = OUTER_RADIUS + 0.1;
    const outer = inner + (major ? 0.13 : 0.06);
    vertices.push(
      Math.cos(angle) * inner, Math.sin(angle) * inner, 0,
      Math.cos(angle) * outer, Math.sin(angle) * outer, 0,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  return geometry;
}

function Instrument({ progress }: { progress: SceneProps['progress'] }) {
  const groupRef = useRef<THREE.Group>(null);
  const [reading, setReading] = useState(0);
  const value = useRef(0);
  const velocity = useRef(0);

  // Start at twelve o'clock, sweep clockwise — negative, because +angle runs
  // anticlockwise and no instrument in the world reads that way.
  const arcGeometry = useMemo(
    () => arcTube(ARC_RADIUS, ARC_TUBE, TOP, -Math.PI * 2, TUBULAR),
    [],
  );
  const trackGeometry = useMemo(
    () => new THREE.TorusGeometry(ARC_RADIUS, ARC_TUBE * 0.45, RADIAL, TUBULAR),
    [],
  );
  const subGeometries = useMemo(
    () =>
      SUBSCORES.map((_, i) => {
        // One quadrant each, with a gap, so the four are directly comparable
        // rather than four arcs on four different scales.
        const gap = 0.16;
        const quadrant = Math.PI / 2;
        return arcTube(
          OUTER_RADIUS,
          OUTER_TUBE,
          TOP - i * quadrant - gap / 2,
          -(quadrant - gap),
          SUB_STEPS,
        );
      }),
    [],
  );
  const ticks = useMemo(tickGeometry, []);

  useFrame((_, rawDelta) => {
    // A tab that has been backgrounded hands back a huge first delta, and an
    // undamped spring integrated over 800ms leaves the scale entirely.
    const delta = Math.min(rawDelta, 1 / 30);
    const p = progress.current;

    const drive = ease(remap(p, 0.12, 0.55, 0, 1));
    const target = drive * TARGET;

    // Underdamped spring: ζ ≈ 0.74, so the needle passes the reading by a few
    // points and settles back onto it.
    const acceleration = (target - value.current) * 90 - velocity.current * 14;
    velocity.current += acceleration * delta;
    value.current += velocity.current * delta;

    const shown = Math.max(0, Math.round(value.current));
    setReading((previous) => (previous === shown ? previous : shown));

    const fraction = clamp01(value.current / 100);
    arcGeometry.setDrawRange(0, Math.floor(fraction * TUBULAR) * INDICES_PER_STEP);

    SUBSCORES.forEach((sub, i) => {
      const drawn = ease(remap(p, 0.2 + i * 0.06, 0.62 + i * 0.06, 0, 1));
      const filled = (sub.value / 100) * drawn;
      subGeometries[i].setDrawRange(0, Math.floor(filled * SUB_STEPS) * INDICES_PER_STEP);
    });

    const group = groupRef.current;
    if (group) {
      group.rotation.z = (1 - drive) * -0.22;
      group.position.z = -(1 - drive) * 1.1;
    }
  });

  return (
    <group ref={groupRef}>
      {/* the ruler */}
      <lineSegments geometry={ticks}>
        <lineBasicMaterial color={IRIDIUM.inkMute} transparent opacity={0.4} toneMapped={false} />
      </lineSegments>

      {/* the unfilled track */}
      <mesh geometry={trackGeometry}>
        <meshBasicMaterial color={IRIDIUM.ink} transparent opacity={0.09} toneMapped={false} />
      </mesh>

      {/* the reading. Lime, because probes ran — see the file header. */}
      <mesh geometry={arcGeometry}>
        <meshBasicMaterial color={earned('read-safe probes executed against the running service')} toneMapped={false} />
      </mesh>

      {/* the four sub-scores, each in its own quadrant */}
      {SUBSCORES.map((sub, i) => (
        <mesh key={sub.name} geometry={subGeometries[i]}>
          <meshBasicMaterial
            color={sub.live ? earned(`${sub.name} probe returned`) : IRIDIUM.iris}
            toneMapped={false}
          />
        </mesh>
      ))}

      <Label text={String(reading)} position={[0, 0.12, 0.2]} height={0.86} colour={IRIDIUM.ink} mono={false} weight={600} size={90} />
      <Label text="agent-ready" position={[0, -0.5, 0.2]} height={0.13} colour={IRIDIUM.inkMute} uppercase letterSpacing={3} size={20} />

      {/* the legend, stated rather than left to be inferred from the colours */}
      <Label text="■ earned live" position={[-1.05, -2.28, 0]} height={0.125} colour={IRIDIUM.verified} size={19} letterSpacing={0.4} />
      <Label text="■ graded from the document" position={[0.72, -2.28, 0]} height={0.125} colour={IRIDIUM.iris2} size={19} letterSpacing={0.4} />
    </group>
  );
}

export default function ScoreInstrument({ active, progress }: SceneProps) {
  const lean = isLowPower();
  return (
    <Stage active={active} camera={{ fov: 46 }} fit={{ width: 5.4, height: 5.4 }}>
      <Instrument progress={progress} />
      {/* The page's second and last sanctioned glow: the gauge arc's halo. */}
      {!lean && (
        <EffectComposer enableNormalPass={false}>
          <Bloom intensity={0.5} luminanceThreshold={0.3} luminanceSmoothing={0.5} mipmapBlur />
        </EffectComposer>
      )}
    </Stage>
  );
}
