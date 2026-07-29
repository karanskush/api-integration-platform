'use client';

import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import Label from '../Label';
import Stage from '../Stage';
import { IRIDIUM } from '../palette';
import type { SceneProps } from '../types';
import { damp } from '../useChapter';

// CHAPTER 2 — one import, two readers.
//
// A single normalised model in the middle, a human integration page hanging
// off one side, three agent clients off the other. Packets run outward along
// both branches continuously, because both surfaces are served from the same
// import — that equivalence is the chapter's whole argument, so the two
// branches are deliberately drawn with the same weight and the same traffic.
//
// The colour split is the contract, not decoration: the page branch is the
// instrument channel, the agent branch is --periwinkle. Nothing here is
// --verified, because nothing here has been verified — this is distribution,
// not measurement.

const CORE = new THREE.Vector3(0, 0, 0);
const PAGE = new THREE.Vector3(-2.9, 0.15, 0);
const AGENTS: Array<{ at: THREE.Vector3; name: string }> = [
  { at: new THREE.Vector3(2.7, 1.35, -0.3), name: 'Claude' },
  { at: new THREE.Vector3(3.1, 0.05, 0.25), name: 'Cursor' },
  { at: new THREE.Vector3(2.7, -1.25, -0.15), name: 'Copilot' },
];

type Branch = {
  curve: THREE.QuadraticBezierCurve3;
  colour: string;
  /** Phase offsets so packets do not pulse in lockstep down every edge. */
  phases: number[];
};

function branch(to: THREE.Vector3, colour: string, phases: number[]): Branch {
  // Bowed rather than straight: a straight line between two nodes reads as a
  // wireframe, a bowed one reads as a connection carrying something.
  const mid = CORE.clone().lerp(to, 0.5);
  mid.z += 0.75;
  mid.y += to.y * 0.18;
  return { curve: new THREE.QuadraticBezierCurve3(CORE.clone(), mid, to.clone()), colour, phases };
}

const PACKETS_PER_BRANCH = 3;

function Constellation({ progress }: { progress: SceneProps['progress'] }) {
  const groupRef = useRef<THREE.Group>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const packetsRef = useRef<THREE.InstancedMesh>(null);
  const elapsed = useRef(0);
  const swing = useRef(0);

  const branches = useMemo<Branch[]>(
    () => [
      branch(PAGE, IRIDIUM.iris, [0, 0.34, 0.67]),
      ...AGENTS.map((agent, i) =>
        branch(agent.at, IRIDIUM.periwinkle, [0.12 + i * 0.07, 0.45 + i * 0.05, 0.79 + i * 0.09]),
      ),
    ],
    [],
  );

  const edgeGeometries = useMemo(() => branches.map((b) => curveSegments(b.curve, 48)), [branches]);

  const packetCount = branches.length * PACKETS_PER_BRANCH;
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // setColorAt, not a hand-attached instanceColor + `vertexColors` — see the
  // note in SpecLattice: that pairing renders every instance black.
  useLayoutEffect(() => {
    const packets = packetsRef.current;
    if (!packets) return;
    const colour = new THREE.Color();
    branches.forEach((b, bi) => {
      colour.set(b.colour);
      for (let p = 0; p < PACKETS_PER_BRANCH; p += 1) {
        packets.setColorAt(bi * PACKETS_PER_BRANCH + p, colour);
      }
    });
    if (packets.instanceColor) packets.instanceColor.needsUpdate = true;
  }, [branches]);

  useFrame((_, delta) => {
    elapsed.current += delta;
    const t = elapsed.current;

    const packets = packetsRef.current;
    if (packets) {
      branches.forEach((b, bi) => {
        b.phases.forEach((phase, pi) => {
          // Wrap on 1 so a packet leaving the far node reappears at the core.
          const u = (t * 0.26 + phase) % 1;
          const point = b.curve.getPointAt(u);
          dummy.position.copy(point);
          // Fade in at the core and out at the destination by scaling, which
          // avoids a per-instance opacity attribute for a five-pixel dot.
          const fade = Math.sin(u * Math.PI);
          dummy.scale.setScalar(0.035 + 0.05 * fade);
          dummy.updateMatrix();
          packets.setMatrixAt(bi * PACKETS_PER_BRANCH + pi, dummy.matrix);
        });
      });
      packets.instanceMatrix.needsUpdate = true;
    }

    const core = coreRef.current;
    if (core) {
      core.rotation.y = t * 0.35;
      core.rotation.x = Math.sin(t * 0.4) * 0.2;
    }

    const group = groupRef.current;
    if (group) {
      // Centred at 0.5 so the constellation faces the reader mid-chapter and
      // swings away at both ends rather than only on exit.
      swing.current = damp(swing.current, progress.current - 0.5, 3, delta);
      group.rotation.y = swing.current * 0.62;
      group.rotation.x = swing.current * -0.2;
      group.position.z = -Math.abs(swing.current) * 1.6;
    }
  });

  return (
    <group ref={groupRef}>
      {/* the normalised model — one import, sitting between its two readers */}
      <mesh ref={coreRef} position={CORE}>
        <icosahedronGeometry args={[0.44, 0]} />
        <meshBasicMaterial color={IRIDIUM.iris} wireframe toneMapped={false} />
      </mesh>
      <mesh position={CORE}>
        <icosahedronGeometry args={[0.26, 0]} />
        <meshBasicMaterial color={IRIDIUM.ink} toneMapped={false} />
      </mesh>
      <Label text="one import" position={[0, -0.78, 0]} height={0.15} colour={IRIDIUM.inkMute} uppercase letterSpacing={2} size={22} />

      {branches.map((b, i) => (
        <lineSegments key={i} geometry={edgeGeometries[i]}>
          <lineBasicMaterial color={b.colour} transparent opacity={0.34} toneMapped={false} depthWrite={false} />
        </lineSegments>
      ))}

      {/* for humans — the integration page */}
      <group position={PAGE}>
        <mesh>
          <planeGeometry args={[1.15, 0.78]} />
          <meshBasicMaterial color={IRIDIUM.iris} transparent opacity={0.14} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
        <lineSegments>
          <edgesGeometry args={[new THREE.PlaneGeometry(1.15, 0.78)]} />
          <lineBasicMaterial color={IRIDIUM.iris} toneMapped={false} />
        </lineSegments>
        <Label text="integration page" position={[0, -0.58, 0]} height={0.15} colour={IRIDIUM.iris2} uppercase letterSpacing={2} size={22} />
        <Label text="for humans" position={[0, 0.58, 0]} height={0.13} colour={IRIDIUM.inkMute} uppercase letterSpacing={2.4} size={20} />
      </group>

      {/* for agents — the hosted MCP server's clients */}
      {AGENTS.map((agent) => (
        <group key={agent.name} position={agent.at}>
          <mesh>
            <circleGeometry args={[0.3, 6]} />
            <meshBasicMaterial color={IRIDIUM.periwinkle} transparent opacity={0.16} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
          <lineSegments>
            <edgesGeometry args={[new THREE.CircleGeometry(0.3, 6)]} />
            <lineBasicMaterial color={IRIDIUM.periwinkle} toneMapped={false} />
          </lineSegments>
          <Label text={agent.name} position={[0.44, 0, 0]} height={0.15} anchor="left" colour={IRIDIUM.periwinkle} size={22} mono={false} weight={600} />
        </group>
      ))}
      <Label text="hosted mcp" position={[2.9, 2.1, 0]} height={0.13} colour={IRIDIUM.inkMute} uppercase letterSpacing={2.4} size={20} />

      <instancedMesh ref={packetsRef} args={[undefined, undefined, packetCount]}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

/**
 * A curve as *pairs* of vertices, for LineSegments.
 *
 * setFromPoints() produces a polyline, which THREE.Line draws correctly and
 * THREE.LineSegments draws as every other segment — a dashed edge nobody
 * asked for. We use LineSegments throughout because `<line>` collides with
 * SVG's line in JSX's intrinsic elements, so the geometry does the adapting.
 */
function curveSegments(curve: THREE.Curve<THREE.Vector3>, divisions: number): THREE.BufferGeometry {
  const points = curve.getPoints(divisions);
  const vertices: number[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    vertices.push(...points[i].toArray(), ...points[i + 1].toArray());
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  return geometry;
}

export default function McpConstellation({ active, progress }: SceneProps) {
  return (
    <Stage active={active} camera={{ fov: 46 }} fit={{ width: 9.2, height: 5.0 }}>
      <Constellation progress={progress} />
    </Stage>
  );
}
