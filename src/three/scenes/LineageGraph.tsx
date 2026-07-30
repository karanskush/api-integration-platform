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
// entire scene. Its port is drawn hollow and its stub ends in an open
// terminal — the schematic mark for a circuit nobody closed — and the
// closing caption hangs off that terminal on a leader line rather than
// floating in space. Recall is measured and printed, never asserted, and a
// low-confidence edge is withheld rather than hedged.
//
// Wires run from a producer's *field port* to the consumer's *row port*:
// lineage is a claim about fields, so the geometry attaches to fields. Under
// each scroll-drawn wire sits the same path at candidate opacity, so a
// half-revealed edge reads as "being derived", never as a broken render.

const PLATE = { w: 2.3, h: 0.98 };
const CONSUMER_PLATE = { w: 2.62, h: 2.06 };

const PRODUCERS = [
  { at: [-2.5, 1.02, 0] as const, method: 'POST' as const, path: '/customers', field: 'response.id' },
  { at: [-2.5, -0.92, 0.12] as const, method: 'GET' as const, path: '/prices', field: 'response.data[].id' },
];

const CONSUMER_AT = [2.25, 0.02, -0.08] as const;

const ROWS = [
  { y: 0.33, field: 'body.customer', origin: 'produced_by_api', linked: true },
  { y: -0.15, field: 'body.items[].price', origin: 'produced_by_api', linked: true },
  { y: -0.63, field: 'body.trial_period_days', origin: 'caller_supplied', linked: false },
];

const EDGES = [
  { from: 0, row: 0, why: 'foreign_key_name · high', reveal: [0.14, 0.46] as const },
  { from: 1, row: 1, why: 'distinctive_name · high', reveal: [0.24, 0.58] as const },
];

/** The producer field row's y, in plate-local space. */
const FIELD_ROW_Y = -0.26;

function edgeCurve(fromIndex: number, rowY: number): THREE.CubicBezierCurve3 {
  const p = PRODUCERS[fromIndex].at;
  const start = new THREE.Vector3(p[0] + PLATE.w / 2 + 0.05, p[1] + FIELD_ROW_Y, p[2]);
  const end = new THREE.Vector3(
    CONSUMER_AT[0] - CONSUMER_PLATE.w / 2 - 0.05,
    CONSUMER_AT[1] + rowY,
    CONSUMER_AT[2],
  );
  return new THREE.CubicBezierCurve3(
    start,
    new THREE.Vector3(start.x + 1.1, start.y, start.z + 0.3),
    new THREE.Vector3(end.x - 1.1, end.y, end.z + 0.3),
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

/** Same vertices, no drawRange — the always-visible candidate path. */
function fullSegmentsFrom(curve: THREE.Curve<THREE.Vector3>, divisions: number) {
  const { geometry } = segmentsFrom(curve, divisions);
  geometry.setDrawRange(0, Infinity);
  return geometry;
}

/**
 * Register ticks just off each plate corner — the drafting mark that says a
 * figure was placed, not screenshotted. Two short strokes per corner,
 * extending outward with a small gap.
 */
function cornerTicks(w: number, h: number, gap = 0.05, len = 0.09): THREE.BufferGeometry {
  const hw = w / 2;
  const hh = h / 2;
  const v: number[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      v.push(sx * (hw + gap), sy * hh, 0, sx * (hw + gap + len), sy * hh, 0);
      v.push(sx * hw, sy * (hh + gap), 0, sx * hw, sy * (hh + gap + len), 0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return geometry;
}

/** A hollow circle outline, for the port nothing is attached to. */
function ringGeometry(radius: number, segments = 40): THREE.BufferGeometry {
  const pts = new THREE.EllipseCurve(0, 0, radius, radius, 0, Math.PI * 2, false, 0)
    .getPoints(segments)
    .map((p) => new THREE.Vector3(p.x, p.y, 0));
  return new THREE.BufferGeometry().setFromPoints(pts);
}

function Plate({ width, height, fill = 0.08 }: { width: number; height: number; fill?: number }) {
  const outline = useMemo(() => new THREE.PlaneGeometry(width, height), [width, height]);
  const ticks = useMemo(() => cornerTicks(width, height), [width, height]);
  return (
    <group>
      <mesh>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial color={IRIDIUM.iris} transparent opacity={fill} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[outline]} />
        <lineBasicMaterial color={IRIDIUM.iris} transparent opacity={0.75} toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={ticks}>
        <lineBasicMaterial color={IRIDIUM.iris} transparent opacity={0.4} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

/** A thin horizontal rule inside a plate. */
function Rule({ width, y, opacity = 0.22 }: { width: number; y: number; opacity?: number }) {
  return (
    <mesh position={[0, y, 0.005]}>
      <planeGeometry args={[width, 0.012]} />
      <meshBasicMaterial color={IRIDIUM.iris} transparent opacity={opacity} toneMapped={false} />
    </mesh>
  );
}

const CHIP_H = 0.22;

/**
 * The method, worn as a chip. POST is filled with the instrument colour —
 * it writes. GET is outlined in the agent channel — read-safe, the traffic
 * an agent may replay. The colour split restates the read/write contract.
 */
function MethodChip({ method, at }: { method: 'POST' | 'GET'; at: [number, number, number] }) {
  const filled = method === 'POST';
  const w = filled ? 0.46 : 0.4;
  const outline = useMemo(() => new THREE.PlaneGeometry(w, CHIP_H), [w]);
  return (
    <group position={at}>
      <mesh>
        <planeGeometry args={[w, CHIP_H]} />
        <meshBasicMaterial
          color={filled ? IRIDIUM.iris : IRIDIUM.periwinkle}
          transparent
          opacity={filled ? 0.9 : 0.12}
          toneMapped={false}
        />
      </mesh>
      {!filled && (
        <lineSegments>
          <edgesGeometry args={[outline]} />
          <lineBasicMaterial color={IRIDIUM.periwinkle} transparent opacity={0.8} toneMapped={false} />
        </lineSegments>
      )}
      <Label
        text={method}
        position={[0, 0, 0.01]}
        height={0.115}
        colour={filled ? IRIDIUM.void : IRIDIUM.periwinkle}
        size={19}
        weight={700}
        letterSpacing={1.2}
      />
    </group>
  );
}

function Graph({ progress }: { progress: SceneProps['progress'] }) {
  const groupRef = useRef<THREE.Group>(null);
  const swing = useRef(0);
  const elapsed = useRef(0);

  const curves = useMemo(() => EDGES.map((edge) => edgeCurve(edge.from, ROWS[edge.row].y)), []);
  const edges = useMemo(() => curves.map((curve) => segmentsFrom(curve, 60)), [curves]);
  const candidates = useMemo(() => curves.map((curve) => fullSegmentsFrom(curve, 60)), [curves]);

  const whyBg = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  const whyBorder = useRef<Array<THREE.LineBasicMaterial | null>>([]);
  const whyText = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  const orphanPulse = useRef<Array<THREE.Material | null>>([]);

  // The dotted sheet the schematic is drawn on. Same substrate move as the
  // constellation's ground, rotated to face the reader: this figure is a
  // drawing, so its world is paper.
  const paper = useMemo(() => {
    const positions: number[] = [];
    for (let x = -4.1; x <= 4.11; x += 0.44) {
      for (let y = -2.0; y <= 1.96; y += 0.44) {
        positions.push(x, y, -0.55);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }, []);

  const orphanRing = useMemo(() => ringGeometry(0.05), []);
  const orphanStub = useMemo(() => {
    const x0 = -CONSUMER_PLATE.w / 2 - 0.05;
    const x1 = -CONSUMER_PLATE.w / 2 - 0.47;
    const y = ROWS[2].y;
    const v = [x0, y, 0, x1, y, 0, x1, y - 0.055, 0, x1, y + 0.055, 0];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    return geometry;
  }, []);

  // Leader from the open terminal down to the closing caption, drafting
  // style: the sentence is an annotation of that terminal, so it attaches.
  const leader = useMemo(() => {
    const v = [0.47, -0.7, 0, 0.55, -1.36, 0];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    return geometry;
  }, []);

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

      // The reasoning lands after the edge does. No link is asserted without
      // the signals that produced it — including in what order.
      const reveal = clamp01(remap(p, edge.reveal[1] - 0.04, edge.reveal[1] + 0.08, 0, 1));
      const bg = whyBg.current[i];
      if (bg) bg.opacity = 0.92 * reveal;
      const border = whyBorder.current[i];
      if (border) border.opacity = 0.35 * reveal;
      const text = whyText.current[i];
      if (text) text.opacity = reveal;
    });

    // The unattached field: a slow, low-amplitude pulse on its hollow port
    // and open stub. Present, addressed, and joined to nothing.
    const pulse = 0.5 + Math.sin(elapsed.current * 1.5) * 0.16;
    orphanPulse.current.forEach((material) => {
      if (material) (material as THREE.LineBasicMaterial).opacity = pulse;
    });

    const group = groupRef.current;
    if (group) {
      swing.current = damp(swing.current, p - 0.5, 3, delta);
      group.rotation.y = swing.current * 0.5;
      group.rotation.x = swing.current * -0.16;
      group.position.z = -Math.abs(swing.current) * 1.4;
    }
  });

  return (
    <group ref={groupRef} position={[0, 0.05, 0]}>
      <points geometry={paper}>
        <pointsMaterial
          color={IRIDIUM.iris}
          size={0.02}
          sizeAttenuation
          transparent
          opacity={0.22}
          depthWrite={false}
          toneMapped={false}
        />
      </points>

      {PRODUCERS.map((producer) => (
        <group key={producer.path} position={[producer.at[0], producer.at[1], producer.at[2]]}>
          <Plate width={PLATE.w} height={PLATE.h} />
          <Label
            text="produces"
            position={[-PLATE.w / 2 + 0.02, PLATE.h / 2 + 0.15, 0]}
            anchor="left"
            height={0.125}
            colour={IRIDIUM.inkMute}
            uppercase
            letterSpacing={2.4}
            size={20}
          />
          <MethodChip method={producer.method} at={[-PLATE.w / 2 + 0.18 + (producer.method === 'POST' ? 0.23 : 0.2), 0.22, 0.01]} />
          <Label
            text={producer.path}
            position={[-PLATE.w / 2 + 0.18 + (producer.method === 'POST' ? 0.46 : 0.4) + 0.12, 0.22, 0.01]}
            anchor="left"
            height={0.2}
            colour={IRIDIUM.ink}
            size={30}
            weight={600}
          />
          <Rule width={PLATE.w - 0.32} y={0} />
          <Label
            text={producer.field}
            position={[-PLATE.w / 2 + 0.18, FIELD_ROW_Y, 0.01]}
            anchor="left"
            height={0.18}
            colour={IRIDIUM.iris2}
            size={27}
          />
          {/* the field's port — where its wire docks */}
          <mesh position={[PLATE.w / 2, FIELD_ROW_Y, 0.01]} renderOrder={2}>
            <circleGeometry args={[0.04, 20]} />
            <meshBasicMaterial color={IRIDIUM.iris2} toneMapped={false} depthWrite={false} />
          </mesh>
        </group>
      ))}

      {EDGES.map((edge, i) => {
        const mid = curves[i].getPointAt(0.52);
        const chipW = whyWidth(edge.why) + 0.24;
        return (
          <group key={edge.why}>
            {/* the candidate path — always present, so a half-drawn edge
                reads as derivation in progress rather than a broken figure */}
            <lineSegments geometry={candidates[i]}>
              <lineBasicMaterial color={IRIDIUM.iris} transparent opacity={0.14} toneMapped={false} depthWrite={false} />
            </lineSegments>
            <lineSegments geometry={edges[i].geometry}>
              <lineBasicMaterial color={IRIDIUM.iris} transparent opacity={0.9} toneMapped={false} depthWrite={false} />
            </lineSegments>
            {/* the signal that produced the link, worn as a chip on the wire */}
            <mesh position={[mid.x, mid.y, mid.z + 0.01]} renderOrder={3}>
              <planeGeometry args={[chipW, 0.26]} />
              <meshBasicMaterial
                ref={(m) => { whyBg.current[i] = m; }}
                color={IRIDIUM.void}
                transparent
                opacity={0}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
            <lineSegments position={[mid.x, mid.y, mid.z + 0.012]} renderOrder={3}>
              <edgesGeometry args={[new THREE.PlaneGeometry(chipW, 0.26)]} />
              <lineBasicMaterial
                ref={(m) => { whyBorder.current[i] = m; }}
                color={IRIDIUM.iris}
                transparent
                opacity={0}
                toneMapped={false}
              />
            </lineSegments>
            <mesh position={[mid.x, mid.y, mid.z + 0.014]} renderOrder={4}>
              <planeGeometry args={[whyWidth(edge.why), WHY_HEIGHT]} />
              <meshBasicMaterial
                ref={(m) => { whyText.current[i] = m; }}
                map={whyTexture(edge.why)}
                transparent
                opacity={0}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          </group>
        );
      })}

      <group position={[CONSUMER_AT[0], CONSUMER_AT[1], CONSUMER_AT[2]]}>
        <Plate width={CONSUMER_PLATE.w} height={CONSUMER_PLATE.h} fill={0.1} />
        <Label
          text="requires"
          position={[-CONSUMER_PLATE.w / 2 + 0.02, CONSUMER_PLATE.h / 2 + 0.15, 0]}
          anchor="left"
          height={0.125}
          colour={IRIDIUM.inkMute}
          uppercase
          letterSpacing={2.4}
          size={20}
        />
        <MethodChip method="POST" at={[-CONSUMER_PLATE.w / 2 + 0.18 + 0.23, 0.74, 0.01]} />
        <Label
          text="/subscriptions"
          position={[-CONSUMER_PLATE.w / 2 + 0.18 + 0.46 + 0.12, 0.74, 0.01]}
          anchor="left"
          height={0.2}
          colour={IRIDIUM.ink}
          size={30}
          weight={600}
        />
        <Rule width={CONSUMER_PLATE.w - 0.32} y={0.55} />

        {ROWS.map((row, i) => (
          <group key={row.field} position={[0, row.y, 0.01]}>
            <Label
              text={row.field}
              position={[-CONSUMER_PLATE.w / 2 + 0.2, 0.02, 0]}
              anchor="left"
              height={0.175}
              colour={row.linked ? IRIDIUM.iris2 : IRIDIUM.ink}
              size={27}
            />
            <Label
              text={row.origin}
              position={[CONSUMER_PLATE.w / 2 - 0.16, 0.02, 0]}
              anchor="right"
              height={0.115}
              colour={IRIDIUM.inkMute}
              size={19}
            />
            {/* each row's port: filled when a wire docks, hollow when none does */}
            {row.linked ? (
              <mesh position={[-CONSUMER_PLATE.w / 2, 0, 0]} renderOrder={2}>
                <circleGeometry args={[0.04, 20]} />
                <meshBasicMaterial color={IRIDIUM.iris2} toneMapped={false} depthWrite={false} />
              </mesh>
            ) : null}
            {i < ROWS.length - 1 && <Rule width={CONSUMER_PLATE.w - 0.36} y={-0.24} opacity={0.12} />}
          </group>
        ))}

        {/* the honest row — an absence, drawn as one: hollow port, open stub */}
        <lineLoop geometry={orphanRing} position={[-CONSUMER_PLATE.w / 2, ROWS[2].y, 0.01]} renderOrder={2}>
          <lineBasicMaterial
            ref={(m) => { orphanPulse.current[0] = m; }}
            color={IRIDIUM.inkDim}
            transparent
            opacity={0.5}
            toneMapped={false}
          />
        </lineLoop>
        <lineSegments geometry={orphanStub} position={[0, 0, 0.01]}>
          <lineBasicMaterial
            ref={(m) => { orphanPulse.current[1] = m; }}
            color={IRIDIUM.inkDim}
            transparent
            opacity={0.5}
            toneMapped={false}
          />
        </lineSegments>
        <Label
          text="no producer"
          position={[-CONSUMER_PLATE.w / 2 - 0.26, ROWS[2].y + 0.14, 0.01]}
          height={0.12}
          colour={IRIDIUM.inkDim}
          size={20}
        />
      </group>

      <lineSegments geometry={leader}>
        <lineBasicMaterial color={IRIDIUM.inkMute} transparent opacity={0.45} toneMapped={false} />
      </lineSegments>
      <Label
        text="nothing produces this."
        position={[0.55, -1.48, 0]}
        anchor="left"
        height={0.16}
        colour={IRIDIUM.inkDim}
        size={26}
        letterSpacing={0.4}
      />
      <Label
        text="we say so, rather than guess."
        position={[0.55, -1.7, 0]}
        anchor="left"
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
    <Stage active={active} camera={{ fov: 48 }} fit={{ width: 7.9, height: 4.5 }}>
      <Graph progress={progress} />
    </Stage>
  );
}
