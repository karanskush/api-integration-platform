'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import Label from '../Label';
import Stage from '../Stage';
import { makeLabel } from '../labelTexture';
import { IRIDIUM } from '../palette';
import type { SceneProps } from '../types';
import { clamp01, damp, ease, remap } from '../useChapter';

// CHAPTER 4 — which call produces the id the next call needs.
//
// The 2D drafting version of this figure (LandingDiagram → now the poster)
// carried a comment worth repeating, because it is the whole reason this
// scene is shaped the way it is:
//
//   "The fourth row is the point of the whole figure: trial_period_days has
//    no producer and is drawn with nothing attached to it. An engine that
//    wanted a good screenshot would have joined it to something."
//
// So: two edges resolve, and one field stays visibly unattached for the
// entire scene. It is the only element here that never animates *into*
// anything, and that stillness is the claim — recall is measured and printed,
// never asserted, and a low-confidence edge is withheld rather than hedged.

const PRODUCERS = [
  { at: [-2.45, 0.98, 0] as const, op: 'POST /customers', field: 'response.id' },
  { at: [-2.45, -0.95, 0.15] as const, op: 'GET /prices', field: 'response.data[].id' },
];

const CONSUMER_AT = [2.05, 0.0, -0.1] as const;

const ROWS = [
  { y: 0.62, field: 'body.customer', origin: 'produced_by_api', linked: true },
  { y: 0.02, field: 'body.items[].price', origin: 'produced_by_api', linked: true },
  { y: -0.58, field: 'body.trial_period_days', origin: 'caller_supplied', linked: false },
];

const EDGES = [
  { from: 0, row: 0, why: 'foreign_key_name · high', reveal: [0.14, 0.46] as const },
  { from: 1, row: 1, why: 'distinctive_name · high', reveal: [0.24, 0.58] as const },
];

const PLATE = { w: 2.0, h: 0.94 };
const CONSUMER_PLATE = { w: 2.4, h: 1.95 };

function edgeCurve(fromIndex: number, rowY: number): THREE.CubicBezierCurve3 {
  const p = PRODUCERS[fromIndex].at;
  const start = new THREE.Vector3(p[0] + PLATE.w / 2, p[1], p[2]);
  const end = new THREE.Vector3(CONSUMER_AT[0] - CONSUMER_PLATE.w / 2, CONSUMER_AT[1] + rowY, CONSUMER_AT[2]);
  return new THREE.CubicBezierCurve3(
    start,
    new THREE.Vector3(start.x + 1.15, start.y, start.z + 0.35),
    new THREE.Vector3(end.x - 1.15, end.y, end.z + 0.35),
    end,
  );
}

/** Segment pairs, so LineSegments can draw a curve and drawRange can grow it. */
function segmentsFrom(curve: THREE.Curve<THREE.Vector3>, divisions: number) {
  const points = curve.getPoints(divisions);
  const vertices: number[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    vertices.push(...points[i].toArray(), ...points[i + 1].toArray());
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setDrawRange(0, 0);
  return { geometry, vertexCount: divisions * 2 };
}

function Plate({
  width,
  height,
  colour,
  fill = 0.07,
}: {
  width: number;
  height: number;
  colour: string;
  fill?: number;
}) {
  const outline = useMemo(() => new THREE.PlaneGeometry(width, height), [width, height]);
  return (
    <group>
      <mesh>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial color={colour} transparent opacity={fill} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[outline]} />
        <lineBasicMaterial color={colour} transparent opacity={0.75} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

function Graph({ progress }: { progress: SceneProps['progress'] }) {
  const groupRef = useRef<THREE.Group>(null);
  const orphanRef = useRef<THREE.Mesh>(null);
  const swing = useRef(0);
  const elapsed = useRef(0);

  const edges = useMemo(
    () => EDGES.map((edge) => segmentsFrom(edgeCurve(edge.from, ROWS[edge.row].y), 60)),
    [],
  );
  const whyRefs = useRef<Array<THREE.Mesh | null>>([]);

  useFrame((_, delta) => {
    elapsed.current += delta;
    const p = progress.current;

    // Edges resolve as the chapter is read, rather than on a timer. Scrolling
    // back up un-draws them, which is honest: this is a derivation, and you
    // are watching it run.
    EDGES.forEach((edge, i) => {
      const t = ease(remap(p, edge.reveal[0], edge.reveal[1], 0, 1));
      const { geometry, vertexCount } = edges[i];
      // Round to a segment boundary so the leading end never renders half a
      // segment pair, which shows up as a flickering stub.
      geometry.setDrawRange(0, Math.floor((vertexCount * t) / 2) * 2);

      const why = whyRefs.current[i];
      if (why) {
        const material = why.material as THREE.MeshBasicMaterial;
        // The reasoning lands after the edge does. No link is asserted
        // without the signals that produced it — including in what order.
        material.opacity = clamp01(remap(p, edge.reveal[1] - 0.04, edge.reveal[1] + 0.08, 0, 1));
      }
    });

    // The unattached field: a slow, low-amplitude pulse. Present, addressed,
    // and joined to nothing.
    const orphan = orphanRef.current;
    if (orphan) {
      const material = orphan.material as THREE.MeshBasicMaterial;
      material.opacity = 0.5 + Math.sin(elapsed.current * 1.5) * 0.16;
    }

    const group = groupRef.current;
    if (group) {
      swing.current = damp(swing.current, p - 0.5, 3, delta);
      group.rotation.y = swing.current * 0.5;
      group.rotation.x = swing.current * -0.16;
      group.position.z = -Math.abs(swing.current) * 1.4;
    }
  });

  return (
    <group ref={groupRef} position={[0, 0.28, 0]}>
      {PRODUCERS.map((producer, i) => (
        <group key={producer.op} position={[producer.at[0], producer.at[1], producer.at[2]]}>
          <Plate width={PLATE.w} height={PLATE.h} colour={IRIDIUM.iris} />
          <Label text="produces" position={[-PLATE.w / 2 + 0.16, 0.28, 0.01]} anchor="left" height={0.135} colour={IRIDIUM.inkMute} uppercase letterSpacing={2.4} size={22} />
          <Label text={producer.op} position={[-PLATE.w / 2 + 0.16, 0.03, 0.01]} anchor="left" height={0.21} colour={IRIDIUM.ink} size={30} weight={600} />
          <Label text={producer.field} position={[-PLATE.w / 2 + 0.16, -0.26, 0.01]} anchor="left" height={0.185} colour={IRIDIUM.iris2} size={28} />
        </group>
      ))}

      {EDGES.map((edge, i) => {
        const curve = edgeCurve(edge.from, ROWS[edge.row].y);
        const mid = curve.getPointAt(0.5);
        return (
          <group key={edge.why}>
            <lineSegments geometry={edges[i].geometry}>
              <lineBasicMaterial color={IRIDIUM.iris} transparent opacity={0.9} toneMapped={false} depthWrite={false} />
            </lineSegments>
            <mesh ref={(node) => { whyRefs.current[i] = node; }} position={[mid.x, mid.y + 0.19, mid.z]} renderOrder={3}>
              <planeGeometry args={[whyWidth(edge.why), WHY_HEIGHT]} />
              <meshBasicMaterial map={whyTexture(edge.why)} transparent opacity={0} depthWrite={false} toneMapped={false} />
            </mesh>
          </group>
        );
      })}

      <group position={[CONSUMER_AT[0], CONSUMER_AT[1], CONSUMER_AT[2]]}>
        <Plate width={CONSUMER_PLATE.w} height={CONSUMER_PLATE.h} colour={IRIDIUM.iris} fill={0.1} />
        <Label text="requires" position={[-CONSUMER_PLATE.w / 2 + 0.18, 0.78, 0.01]} anchor="left" height={0.135} colour={IRIDIUM.inkMute} uppercase letterSpacing={2.4} size={22} />
        <Label text="POST /subscriptions" position={[-CONSUMER_PLATE.w / 2 + 0.18, 0.98, 0.01]} anchor="left" height={0.21} colour={IRIDIUM.ink} size={30} weight={600} />

        {ROWS.map((row) => (
          <group key={row.field} position={[0, row.y, 0.01]}>
            <Label text={row.field} position={[-CONSUMER_PLATE.w / 2 + 0.18, 0.07, 0]} anchor="left" height={0.175} colour={row.linked ? IRIDIUM.iris2 : IRIDIUM.ink} size={28} />
            <Label text={row.origin} position={[-CONSUMER_PLATE.w / 2 + 0.18, -0.12, 0]} anchor="left" height={0.135} colour={IRIDIUM.inkMute} size={22} />
          </group>
        ))}

        {/* the honest row — an absence, drawn as one */}
        <mesh ref={orphanRef} position={[-CONSUMER_PLATE.w / 2 - 0.34, ROWS[2].y, 0.01]} renderOrder={3}>
          <planeGeometry args={[whyWidth('no producer', IRIDIUM.inkMute), WHY_HEIGHT]} />
          <meshBasicMaterial map={whyTexture('no producer', IRIDIUM.inkMute)} transparent opacity={0.5} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>

      <Label
        text="nothing produces this. we say so, rather than guess."
        position={[0.1, -2.05, 0]}
        height={0.16}
        colour={IRIDIUM.inkMute}
        size={26}
        letterSpacing={0.4}
      />
    </group>
  );
}

// The edge-reason planes size themselves to their own text but cannot use
// <Label>: they need a material ref to animate opacity, which Label does not
// expose on purpose (a label that can be faded from outside is a label that
// can be faded to nothing while still claiming to be readable).
const WHY_STYLE = { size: 26, letterSpacing: 0.4 } as const;
const WHY_HEIGHT = 0.155;

function whyTexture(text: string, colour: string = IRIDIUM.inkDim) {
  return makeLabel(text, { ...WHY_STYLE, colour }).texture;
}
function whyWidth(text: string, colour: string = IRIDIUM.inkDim) {
  return WHY_HEIGHT * makeLabel(text, { ...WHY_STYLE, colour }).aspect;
}

export default function LineageGraph({ active, progress }: SceneProps) {
  return (
    <Stage active={active} camera={{ fov: 48 }} fit={{ width: 7.2, height: 4.6 }}>
      <Graph progress={progress} />
    </Stage>
  );
}
