'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import Label from '../Label';
import Stage from '../Stage';
import { IRIDIUM } from '../palette';
import type { SceneProps } from '../types';
import { clamp01, damp, ease, remap } from '../useChapter';

// CHAPTER 6 — verified, not transpiled.
//
// Two stacks of the same response object: on the left what the spec promised,
// on the right what the running service actually returned. They start in
// register, drift apart as the chapter is read, and the difference resolves
// into one extra field the document never mentioned — `status:
// "pending_review"` — which lights --drift, because it was *caught*, not
// because it failed.
//
// Then the documented stack accepts it. That last beat is the product: a
// transpiler would have shipped the spec's shape and let an agent discover
// the extra enum member in production.

const FIELDS = [
  { name: 'id', type: 'string' },
  { name: 'amount', type: 'integer' },
  { name: 'currency', type: 'string' },
  { name: 'status', type: 'enum' },
];

const UNDOCUMENTED = { name: 'status: "pending_review"', type: 'undocumented' };

const ROW_H = 0.34;
const ROW_W = 2.05;
const GAP = 0.06;

function rowY(index: number, total: number) {
  return ((total - 1) / 2 - index) * (ROW_H + GAP);
}

function Row({
  label,
  colour,
  fill,
  y,
  outlineOnly = false,
}: {
  label: string;
  colour: string;
  fill: number;
  y: number;
  outlineOnly?: boolean;
}) {
  const plane = useMemo(() => new THREE.PlaneGeometry(ROW_W, ROW_H), []);
  return (
    <group position={[0, y, 0]}>
      {!outlineOnly && (
        <mesh>
          <planeGeometry args={[ROW_W, ROW_H]} />
          <meshBasicMaterial color={colour} transparent opacity={fill} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      <lineSegments>
        <edgesGeometry args={[plane]} />
        <lineBasicMaterial color={colour} transparent opacity={outlineOnly ? 0.4 : 0.7} toneMapped={false} />
      </lineSegments>
      <Label text={label} position={[-ROW_W / 2 + 0.14, 0, 0.01]} anchor="left" height={0.135} colour={colour} size={21} />
    </group>
  );
}

function Drift({ progress }: { progress: SceneProps['progress'] }) {
  const groupRef = useRef<THREE.Group>(null);
  const documentedRef = useRef<THREE.Group>(null);
  const observedRef = useRef<THREE.Group>(null);
  const extraRef = useRef<THREE.Group>(null);
  const patchRef = useRef<THREE.Mesh>(null);
  const swing = useRef(0);
  const elapsed = useRef(0);

  useFrame((_, delta) => {
    elapsed.current += delta;
    const p = progress.current;

    // 0.10 → 0.40  the two stacks separate: the spec and the service diverge
    const split = ease(remap(p, 0.1, 0.4, 0, 1));
    // 0.40 → 0.62  the undocumented field surfaces on the observed side
    const surface = ease(remap(p, 0.4, 0.62, 0, 1));
    // 0.66 → 0.88  the tool schema is patched to match what came back
    const patch = ease(remap(p, 0.66, 0.88, 0, 1));

    if (documentedRef.current) documentedRef.current.position.x = -0.35 - split * 1.5;
    if (observedRef.current) observedRef.current.position.x = 0.35 + split * 1.5;

    const extra = extraRef.current;
    if (extra) {
      extra.visible = surface > 0.01;
      extra.scale.setScalar(0.6 + surface * 0.4);
      extra.position.y = rowY(4, 5) - (1 - surface) * 0.25;
      // A caught finding announces itself, then settles. It does not keep
      // flashing — this is a report, not an alarm panel.
      const pulse = 1 - Math.min(1, surface) * 0.55;
      extra.children.forEach((child) => {
        const mesh = child as THREE.Mesh;
        const material = mesh.material as THREE.Material | undefined;
        if (material && 'opacity' in material) {
          (material as THREE.MeshBasicMaterial).opacity =
            clamp01(surface) * (0.45 + Math.sin(elapsed.current * 2.4) * 0.14 * pulse);
        }
      });
    }

    // The patch: a line drawn from the observed extra field back to the
    // documented stack, then the documented stack gaining the row.
    const patchMesh = patchRef.current;
    if (patchMesh) {
      const material = patchMesh.material as THREE.MeshBasicMaterial;
      material.opacity = patch * 0.9;
      patchMesh.scale.x = 0.001 + patch;
    }

    const group = groupRef.current;
    if (group) {
      swing.current = damp(swing.current, p - 0.5, 3, delta);
      group.rotation.y = swing.current * 0.4;
      group.rotation.x = swing.current * -0.14;
    }
  });

  const extraPlane = useMemo(() => new THREE.PlaneGeometry(ROW_W, ROW_H), []);

  return (
    <group ref={groupRef}>
      {/* documented — what the spec promised */}
      <group ref={documentedRef}>
        <Label text="documented" position={[0, rowY(-1, 4) + 0.12, 0]} height={0.12} colour={IRIDIUM.inkMute} uppercase letterSpacing={2.4} size={19} />
        {FIELDS.map((field, i) => (
          <Row key={field.name} label={`${field.name}: ${field.type}`} colour={IRIDIUM.periwinkle} fill={0.05} y={rowY(i, 4)} outlineOnly />
        ))}
      </group>

      {/* observed — what the running service actually returned */}
      <group ref={observedRef}>
        <Label text="observed" position={[0, rowY(-1, 5) + 0.12, 0]} height={0.12} colour={IRIDIUM.inkMute} uppercase letterSpacing={2.4} size={19} />
        {FIELDS.map((field, i) => (
          <Row key={field.name} label={`${field.name}: ${field.type}`} colour={IRIDIUM.iris} fill={0.11} y={rowY(i, 5)} />
        ))}

        {/* the drift, caught */}
        <group ref={extraRef} visible={false}>
          <mesh>
            <planeGeometry args={[ROW_W, ROW_H]} />
            <meshBasicMaterial color={IRIDIUM.drift} transparent opacity={0} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
          <lineSegments>
            <edgesGeometry args={[extraPlane]} />
            <lineBasicMaterial color={IRIDIUM.drift} transparent opacity={0} toneMapped={false} />
          </lineSegments>
          <Label text={UNDOCUMENTED.name} position={[-ROW_W / 2 + 0.14, 0, 0.01]} anchor="left" height={0.13} colour={IRIDIUM.drift} size={20} />
        </group>
      </group>

      {/* the patch — drawn back toward the documented side */}
      <mesh ref={patchRef} position={[0, rowY(4, 5), -0.02]} renderOrder={1}>
        <planeGeometry args={[2.4, 0.012]} />
        <meshBasicMaterial color={IRIDIUM.drift} transparent opacity={0} toneMapped={false} />
      </mesh>

      <Label
        text="tool schema patched automatically · re-verified before an agent sees it"
        position={[0, -1.5, 0]}
        height={0.125}
        colour={IRIDIUM.inkMute}
        size={19}
        letterSpacing={0.3}
      />
    </group>
  );
}

export default function DriftScene({ active, progress }: SceneProps) {
  return (
    <Stage active={active} camera={{ fov: 46 }} fit={{ width: 6.6, height: 4.2 }}>
      <Drift progress={progress} />
    </Stage>
  );
}
