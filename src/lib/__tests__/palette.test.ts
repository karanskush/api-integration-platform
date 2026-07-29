import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSS_VAR_NAMES, IRIDIUM, type IridiumKey } from '../../three/palette';

// The IRIDIUM hexes live in two files that cannot import each other: the
// `:root` block in globals.css, and src/three/palette.ts. Both are real
// sources — CSS paints the DOM, palette.ts paints the WebGL scenes — so a
// drift between them shows up as a scene whose accent is a slightly stale
// violet, which is exactly the class of bug nobody files.
//
// This reads the CSS and asserts they agree.

const CSS_PATH = join(process.cwd(), 'src/app/globals.css');

/** Pull `--name: #hex;` declarations out of the first :root block. */
function readRootVars(css: string): Map<string, string> {
  const start = css.indexOf(':root {');
  expect(start, 'globals.css should declare a :root block').toBeGreaterThan(-1);
  const end = css.indexOf('\n}', start);
  expect(end, ':root block should be closed').toBeGreaterThan(start);

  const block = css.slice(start, end);
  const vars = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    vars.set(match[1], match[2].toLowerCase());
  }
  return vars;
}

describe('IRIDIUM palette', () => {
  const rootVars = readRootVars(readFileSync(CSS_PATH, 'utf8'));

  it.each(Object.keys(IRIDIUM) as IridiumKey[])(
    'palette.ts %s matches its CSS custom property',
    (key) => {
      const cssName = CSS_VAR_NAMES[key];
      expect(rootVars.get(cssName), `${cssName} should be a literal hex in :root`).toBe(
        IRIDIUM[key],
      );
    },
  );

  it('leaves no IRIDIUM key unmapped to a CSS variable', () => {
    // Record<IridiumKey, string> already makes this a type error, but the map
    // is also the thing the loop above iterates — so an entry pointing at a
    // variable that does not exist would otherwise fail as a confusing
    // undefined rather than as "you renamed a token".
    for (const cssName of Object.values(CSS_VAR_NAMES)) {
      expect(rootVars.has(cssName), `${cssName} is missing from :root`).toBe(true);
    }
  });

  it('keeps every channel legible on every substrate', () => {
    // The palette's whole job is that a caught drift and an earned pass read
    // differently at a glance. That fails silently if a token drifts dark, so
    // the ratios are asserted rather than eyeballed once at design time.
    const substrates: IridiumKey[] = ['void', 'surface', 'raised'];
    const foregrounds: IridiumKey[] = [
      'ink',
      'inkDim',
      'inkMute',
      'iris2',
      'periwinkle',
      'verified',
      'drift',
      'fail',
    ];

    for (const bg of substrates) {
      for (const fg of foregrounds) {
        const ratio = contrast(IRIDIUM[fg], IRIDIUM[bg]);
        expect(
          ratio,
          `${fg} on ${bg} is ${ratio.toFixed(2)}:1, below the 4.5:1 floor`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const int = parseInt(hex.slice(1), 16);
  const channels = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
