// IRIDIUM, as data.
//
// CSS cannot import TypeScript, so these hexes exist in two places: the
// `:root` block in src/app/globals.css and here. That is a duplication, and
// duplication drifts — so src/lib/__tests__/palette.test.ts reads the CSS and
// fails if the two ever disagree. Same habit as FIELD_ORIGINS and
// Record<Archetype, …> on the landing page: make the wrong state unbuildable
// rather than merely discouraged.
//
// Deliberately free of any `three` import. These are plain strings; r3f
// accepts them anywhere a colour is expected, and keeping this module
// dependency-free means the guard test does not have to load a 3D engine.

export const IRIDIUM = {
  /* substrate — obsidian, faintly blue */
  void: '#08080c',
  surface: '#101018',
  raised: '#17171f',

  /* ink */
  ink: '#edecf5',
  inkDim: '#a2a0b4',
  inkMute: '#828098',

  /* channels */
  iris: '#7a5cff',
  iris2: '#9b84ff',
  periwinkle: '#8fa0ff',
  verified: '#b6ff3d',
  drift: '#ffb020',
  fail: '#ff5f7e',
} as const;

export type IridiumKey = keyof typeof IRIDIUM;

/** The CSS custom-property name each key mirrors. The test walks this map. */
export const CSS_VAR_NAMES: Record<IridiumKey, string> = {
  void: '--void',
  surface: '--surface',
  raised: '--raised',
  ink: '--ink',
  inkDim: '--ink-dim',
  inkMute: '--ink-mute',
  iris: '--iris',
  iris2: '--iris-2',
  periwinkle: '--periwinkle',
  verified: '--verified',
  drift: '--drift',
  fail: '--fail',
};

/**
 * The colour contract, expressed so a scene author does not have to remember
 * it. `verified` is absent on purpose: a scene may only reach for it through
 * `earned()`, which forces the caller to name the event that earned it.
 */
export const CHANNEL = {
  /** Links, focus, keylines, rules, dimension lines. Always safe. */
  instrument: IRIDIUM.iris,
  /** Agent-side surfaces: MCP nodes, agent clients, GET traffic. */
  agent: IRIDIUM.periwinkle,
  /** Structure that is present but not being pointed at. */
  quiet: IRIDIUM.inkMute,
  /** Drift that was caught. Not a failure — a finding. */
  caught: IRIDIUM.drift,
} as const;

/**
 * The only sanctioned way to reach for `--verified` from a scene.
 *
 * It takes the verification event as an argument and ignores it. That looks
 * pointless and is not: it means a reviewer reading `earned('probe passed')`
 * can check the claim, and it means you cannot type this colour into a scene
 * without stating, in the call, what earned it.
 */
export function earned(_verificationEvent: string): string {
  return IRIDIUM.verified;
}
