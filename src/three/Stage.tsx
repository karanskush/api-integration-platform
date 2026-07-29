'use client';

import { AdaptiveDpr, Preload } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { useLayoutEffect, type ReactNode } from 'react';
import type { PerspectiveCamera } from 'three';
import { isLowPower } from './env';

/**
 * Pull the camera back until `bounds` fits the canvas, whatever shape it is.
 *
 * Hand-tuned camera distances are how a scene ends up perfect at 1440px and
 * cropped at 1280px. Each scene declares the world-space box it needs to be
 * able to show; this solves for the distance that shows it, on every viewport,
 * and re-solves on resize.
 */
function FitCamera({ width, height, padding }: { width: number; height: number; padding: number }) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  useLayoutEffect(() => {
    const cam = camera as PerspectiveCamera;
    if (!cam.isPerspectiveCamera || !size.width || !size.height) return;
    const halfFov = Math.tan(((cam.fov * Math.PI) / 180) / 2);
    const aspect = size.width / size.height;
    // Whichever axis is the binding constraint wins.
    const forHeight = (height * padding) / (2 * halfFov);
    const forWidth = (width * padding) / (2 * halfFov * aspect);
    cam.position.z = Math.max(forHeight, forWidth);
    cam.updateProjectionMatrix();
  }, [camera, size, width, height, padding]);

  return null;
}

/**
 * Narrower than r3f's CameraProps on purpose. That type is a union covering
 * orthographic and manual cameras, and spreading a partial into it collapses
 * to an unresolvable overload. Every scene here wants the same perspective
 * camera with a different position and field of view.
 */
export type StageCamera = {
  position?: [number, number, number];
  fov?: number;
  near?: number;
  far?: number;
};

export type StageProps = {
  children: ReactNode;
  /**
   * False parks the render loop. SceneStage drives this from intersection +
   * document visibility, so an off-screen scene and a backgrounded tab both
   * cost zero frames rather than "a cheap frame" — which, five scenes deep,
   * is the difference between a page and a space heater.
   */
  active: boolean;
  camera?: StageCamera;
  /**
   * The world-space box this scene must always be able to show. Given it, the
   * camera solves its own distance per viewport — see FitCamera.
   */
  fit?: { width: number; height: number; padding?: number };
  className?: string;
};

export default function Stage({ children, active, camera, fit, className }: StageProps) {
  const lean = isLowPower();

  return (
    <Canvas
      // r3f wraps the canvas in its own sized div, so the class has to land on
      // the wrapper for it to fill the .scene box rather than collapse to zero.
      className={className ? `scene-canvas ${className}` : 'scene-canvas'}
      // 'never' still renders on demand via invalidate(); it just stops the
      // continuous loop. Nothing here calls invalidate(), so it is a full stop.
      frameloop={active ? 'always' : 'never'}
      dpr={[1, lean ? 1.5 : 2]}
      gl={{
        antialias: !lean,
        alpha: true,
        powerPreference: 'high-performance',
        // The page ground is already --void; a second opaque clear would just
        // mean the canvas edges cannot be feathered into it.
        premultipliedAlpha: true,
      }}
      camera={{
        fov: camera?.fov ?? 42,
        near: camera?.near ?? 0.1,
        far: camera?.far ?? 100,
        position: camera?.position ?? [0, 0, 9],
      }}
      // The canvas carries no information a screen reader can use — every
      // scene's claim is on its poster twin, which stays in the a11y tree.
      aria-hidden="true"
    >
      <AdaptiveDpr pixelated={false} />
      {fit && <FitCamera width={fit.width} height={fit.height} padding={fit.padding ?? 1.08} />}
      {children}
      <Preload all />
    </Canvas>
  );
}
