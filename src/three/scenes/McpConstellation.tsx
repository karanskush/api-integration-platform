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
// A single normalised model, a human integration page hanging off one side,
// and the hosted MCP server off the other with three agent clients fanned
// behind it. The MCP server is drawn as a node rather than a caption because
// it is the thing we run — the clients are other people's software, the
// junction is ours. Packets run outward along both branches continuously,
// because both surfaces are served from the same import; that equivalence is
// the chapter's whole argument, so the two branches carry the same traffic.
//
// The colour split is the contract, not decoration: the page branch is the
// instrument channel, the agent branch is --periwinkle. Nothing here is
// --verified, because nothing here has been verified — this is distribution,
// not measurement.
//
// The dotted ground and the broadcast rings exist to give the void structure.
// Without them the figure floats on nothing and the emptiness reads as an
// unfinished render; with them it reads as a chart drawn on a surface.

const CORE = new THREE.Vector3(-0.55, 0.1, 0);
const PAGE = new THREE.Vector3(-3.45, 0.1, 0);
const MCP = new THREE.Vector3(1.6, 0.1, 0.05);
const AGENTS: Array<{ at: THREE.Vector3; name: string }> = [
  { at: new THREE.Vector3(3.7, 1.32, -0.25), name: 'Claude' },
  { at: new THREE.Vector3(3.95, 0.08, 0.2), name: 'Cursor' },
  { at: new THREE.Vector3(3.7, -1.18, -0.1), name: 'Copilot' },
];

const PAGE_PLATE = { w: 1.34, h: 0.92 };
const GROUND_Y = -2.05;

type Branch = {
  curve: THREE.QuadraticBezierCurve3;
  colour: string;
  /** Phase offsets so packets do not pulse in lockstep down every edge. */
  phases: number[];
};

/**
 * Trim a centre-to-centre run back to the two node boundaries, so an edge
 * visibly *docks* at a port instead of diving underneath the node's fill.
 */
function trimmed(from: THREE.Vector3, to: THREE.Vector3, trimFrom: number, trimTo: number) {
  const dir = to.clone().sub(from).normalize();
  return {
    start: from.clone().add(dir.clone().multiplyScalar(trimFrom)),
    end: to.clone().sub(dir.clone().multiplyScalar(trimTo)),
  };
}

function branch(
  from: THREE.Vector3,
  to: THREE.Vector3,
  trims: [number, number],
  colour: string,
  phases: number[],
): Branch {
  const { start, end } = trimmed(from, to, trims[0], trims[1]);
  // Bowed rather than straight: a straight line between two nodes reads as a
  // wireframe, a bowed one reads as a connection carrying something.
  const mid = start.clone().lerp(end, 0.5);
  mid.z += 0.5;
  mid.y += (end.y - start.y) * 0.12;
  return { curve: new THREE.QuadraticBezierCurve3(start, mid, end), colour, phases };
}

const PACKETS_PER_BRANCH = 3;

/** A flat circle outline; LineLoop closes it without a duplicate vertex. */
function ringGeometry(radius: number, segments = 72): THREE.BufferGeometry {
  const pts = new THREE.EllipseCurve(0, 0, radius, radius, 0, Math.PI * 2, false, 0)
    .getPoints(segments)
    .map((p) => new THREE.Vector3(p.x, p.y, 0));
  return new THREE.BufferGeometry().setFromPoints(pts);
}

function Constellation({ progress }: { progress: SceneProps['progress'] }) {
  const groupRef = useRef<THREE.Group>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const gimbalA = useRef<THREE.Group>(null);
  const gimbalB = useRef<THREE.Group>(null);
  const packetsRef = useRef<THREE.InstancedMesh>(null);
  const elapsed = useRef(0);
  const swing = useRef(0);

  const branches = useMemo<Branch[]>(
    () => [
      branch(CORE, PAGE, [0.52, PAGE_PLATE.w / 2 + 0.06], IRIDIUM.iris, [0, 0.34, 0.67]),
      branch(CORE, MCP, [0.52, 0.42], IRIDIUM.periwinkle, [0.1, 0.44, 0.78]),
      ...AGENTS.map((agent, i) =>
        branch(MCP, agent.at, [0.42, 0.38], IRIDIUM.periwinkle, [
          0.12 + i * 0.07,
          0.45 + i * 0.05,
          0.79 + i * 0.09,
        ]),
      ),
    ],
    [],
  );

  const edgeGeometries = useMemo(() => branches.map((b) => curveSegments(b.curve, 48)), [branches]);

  // Every edge docks at a visible port on each node boundary. The dots are
  // what turns "a line near a shape" into "a connection to an addressable
  // thing" — the same move the lineage chapter makes with field ports.
  const ports = useMemo(
    () =>
      branches.flatMap((b) => [
        { at: b.curve.getPointAt(0), colour: b.colour },
        { at: b.curve.getPointAt(1), colour: b.colour },
      ]),
    [branches],
  );

  // The dotted ground. Plain grid of points, swung with the group, so the
  // scene sits *on* something at every scroll position.
  const ground = useMemo(() => {
    const positions: number[] = [];
    for (let x = -4.8; x <= 4.81; x += 0.42) {
      for (let z = -2.8; z <= 2.21; z += 0.42) {
        positions.push(x, GROUND_Y, z);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }, []);

  const groundRings = useMemo(() => [0.8, 1.5, 2.2].map((r) => ringGeometry(r)), []);
  const gimbalRings = useMemo(() => [ringGeometry(0.58), ringGeometry(0.72)], []);

  const packetCount = branches.length * PACKETS_PER_BRANCH;
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tangent = useMemo(() => new THREE.Vector3(), []);

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
          // Oriented along the curve and stretched into a comet: traffic,
          // not a bouncing ball. Fade by scale at both ends, which avoids a
          // per-instance opacity attribute for a five-pixel streak.
          b.curve.getTangentAt(u, tangent);
          dummy.lookAt(point.x + tangent.x, point.y + tangent.y, point.z + tangent.z);
          const fade = Math.sin(u * Math.PI);
          const s = 0.022 + 0.03 * fade;
          dummy.scale.set(s, s, s * 3.4);
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
    // The gimbal pair counter-rotates slowly around the core — an instrument
    // being read, not a model spinning for attention.
    const a = gimbalA.current;
    if (a) a.rotation.set(1.12, t * 0.3, 0);
    const b = gimbalB.current;
    if (b) b.rotation.set(-0.82 + Math.sin(t * 0.2) * 0.08, -t * 0.24, 0.42);

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
      {/* substrate — dotted ground plus broadcast rings centred on the core */}
      <points geometry={ground}>
        <pointsMaterial
          color={IRIDIUM.iris}
          size={0.022}
          sizeAttenuation
          transparent
          opacity={0.28}
          depthWrite={false}
          toneMapped={false}
        />
      </points>
      <group position={[CORE.x, GROUND_Y + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        {groundRings.map((geometry, i) => (
          <lineLoop key={i} geometry={geometry}>
            <lineBasicMaterial
              color={IRIDIUM.iris}
              transparent
              opacity={0.13 - i * 0.035}
              toneMapped={false}
              depthWrite={false}
            />
          </lineLoop>
        ))}
      </group>

      {/* the normalised model — one import, sitting between its two readers */}
      <group position={CORE}>
        <mesh ref={coreRef}>
          <icosahedronGeometry args={[0.44, 0]} />
          <meshBasicMaterial color={IRIDIUM.iris} wireframe toneMapped={false} />
        </mesh>
        <mesh>
          <icosahedronGeometry args={[0.24, 0]} />
          <meshBasicMaterial color={IRIDIUM.ink} toneMapped={false} />
        </mesh>
        <group ref={gimbalA}>
          <lineLoop geometry={gimbalRings[0]}>
            <lineBasicMaterial color={IRIDIUM.iris} transparent opacity={0.3} toneMapped={false} depthWrite={false} />
          </lineLoop>
        </group>
        <group ref={gimbalB}>
          <lineLoop geometry={gimbalRings[1]}>
            <lineBasicMaterial color={IRIDIUM.iris2} transparent opacity={0.2} toneMapped={false} depthWrite={false} />
          </lineLoop>
        </group>
        <Label text="one import" position={[0, -0.95, 0]} height={0.15} colour={IRIDIUM.inkMute} uppercase letterSpacing={2} size={22} />
      </group>

      {branches.map((b, i) => (
        <lineSegments key={i} geometry={edgeGeometries[i]}>
          <lineBasicMaterial color={b.colour} transparent opacity={0.34} toneMapped={false} depthWrite={false} />
        </lineSegments>
      ))}

      {ports.map((port, i) => (
        <mesh key={i} position={port.at} renderOrder={2}>
          <circleGeometry args={[0.034, 16]} />
          <meshBasicMaterial color={port.colour} transparent opacity={0.9} toneMapped={false} depthWrite={false} />
        </mesh>
      ))}

      {/* for humans — the integration page, drawn as a document rather than
          an empty frame: header rule, body lines, a try-it control */}
      <group position={PAGE}>
        <mesh>
          <planeGeometry args={[PAGE_PLATE.w, PAGE_PLATE.h]} />
          <meshBasicMaterial color={IRIDIUM.iris} transparent opacity={0.1} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
        <lineSegments>
          <edgesGeometry args={[new THREE.PlaneGeometry(PAGE_PLATE.w, PAGE_PLATE.h)]} />
          <lineBasicMaterial color={IRIDIUM.iris} toneMapped={false} />
        </lineSegments>
        <mesh position={[-0.12, 0.3, 0.005]}>
          <planeGeometry args={[0.86, 0.016]} />
          <meshBasicMaterial color={IRIDIUM.iris} transparent opacity={0.55} toneMapped={false} />
        </mesh>
        {[0.14, 0.01, -0.12].map((y, i) => (
          <mesh key={y} position={[-0.12 - (i === 2 ? 0.14 : 0), y, 0.005]}>
            <planeGeometry args={[i === 2 ? 0.58 : 0.86, 0.014]} />
            <meshBasicMaterial color={IRIDIUM.inkMute} transparent opacity={0.32} toneMapped={false} />
          </mesh>
        ))}
        <mesh position={[-0.34, -0.3, 0.005]}>
          <planeGeometry args={[0.42, 0.15]} />
          <meshBasicMaterial color={IRIDIUM.iris} transparent opacity={0.32} toneMapped={false} />
        </mesh>
        <Label text="for humans" position={[0, 0.65, 0]} height={0.13} colour={IRIDIUM.inkMute} uppercase letterSpacing={2.4} size={20} />
        <Label text="integration page" position={[0, -0.66, 0]} height={0.15} colour={IRIDIUM.iris2} uppercase letterSpacing={2} size={22} />
      </group>

      {/* for agents — the hosted MCP server we run, then its clients */}
      <group position={MCP}>
        <mesh>
          <circleGeometry args={[0.36, 6]} />
          <meshBasicMaterial color={IRIDIUM.periwinkle} transparent opacity={0.18} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
        <lineSegments>
          <edgesGeometry args={[new THREE.CircleGeometry(0.36, 6)]} />
          <lineBasicMaterial color={IRIDIUM.periwinkle} toneMapped={false} />
        </lineSegments>
        <lineSegments>
          <edgesGeometry args={[new THREE.CircleGeometry(0.21, 6)]} />
          <lineBasicMaterial color={IRIDIUM.periwinkle} transparent opacity={0.5} toneMapped={false} />
        </lineSegments>
        <Label text="for agents" position={[0, 0.65, 0]} height={0.13} colour={IRIDIUM.inkMute} uppercase letterSpacing={2.4} size={20} />
        <Label text="hosted mcp" position={[0, -0.62, 0]} height={0.15} colour={IRIDIUM.periwinkle} uppercase letterSpacing={2} size={22} />
      </group>

      {AGENTS.map((agent) => (
        <group key={agent.name} position={agent.at}>
          <mesh>
            <circleGeometry args={[0.3, 6]} />
            <meshBasicMaterial color={IRIDIUM.periwinkle} transparent opacity={0.14} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
          <lineSegments>
            <edgesGeometry args={[new THREE.CircleGeometry(0.3, 6)]} />
            <lineBasicMaterial color={IRIDIUM.periwinkle} toneMapped={false} />
          </lineSegments>
          <Label text={agent.name} position={[0.44, 0, 0]} height={0.15} anchor="left" colour={IRIDIUM.periwinkle} size={22} mono={false} weight={600} />
        </group>
      ))}

      <instancedMesh ref={packetsRef} args={[undefined, undefined, packetCount]}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial toneMapped={false} blending={THREE.AdditiveBlending} depthWrite={false} transparent />
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
    <Stage active={active} camera={{ fov: 46 }} fit={{ width: 10.2, height: 5.3 }}>
      <Constellation progress={progress} />
    </Stage>
  );
}
