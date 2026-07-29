'use client';

import { useMemo } from 'react';
import { makeLabel, type LabelOptions } from './labelTexture';

export type LabelProps = LabelOptions & {
  text: string;
  position?: [number, number, number];
  /** World height of the text box. Width follows from the measured glyphs. */
  height?: number;
  anchor?: 'left' | 'center' | 'right';
  opacity?: number;
  renderOrder?: number;
};

export default function Label({
  text,
  position = [0, 0, 0],
  height = 0.17,
  anchor = 'center',
  opacity = 1,
  renderOrder = 2,
  ...options
}: LabelProps) {
  const { texture, aspect } = useMemo(
    () => makeLabel(text, options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, options.colour, options.size, options.weight, options.mono, options.letterSpacing, options.uppercase],
  );

  const width = height * aspect;
  const dx = anchor === 'left' ? width / 2 : anchor === 'right' ? -width / 2 : 0;

  return (
    <mesh position={[position[0] + dx, position[1], position[2]]} renderOrder={renderOrder}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
