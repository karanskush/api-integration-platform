import type { RefObject } from 'react';

export type SceneProps = {
  /** Render-loop gate — off-screen and backgrounded scenes cost no frames. */
  active: boolean;
  /** Chapter travel through the viewport, 0 → 1. Read inside useFrame. */
  progress: RefObject<number>;
};
