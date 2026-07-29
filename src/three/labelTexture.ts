import * as THREE from 'three';

// Text in the scenes, without shipping a font atlas.
//
// drei's <Text> is the usual answer, but it fetches a typeface from a CDN at
// runtime — a third-party request on the critical path of a landing page, and
// a blank label whenever that request fails. These scenes carry real operation
// names and field paths, so a blank label is a broken claim, not a cosmetic
// nit. Canvas 2D is self-contained, cached per string, and sharp enough at 2×.

const cache = new Map<string, LabelTexture>();

export type LabelTexture = {
  texture: THREE.CanvasTexture;
  /** World-space width for a plane 1 unit tall. */
  aspect: number;
};

export type LabelOptions = {
  colour?: string;
  /** Cap height in CSS pixels before the 2× scale-up. */
  size?: number;
  weight?: number;
  mono?: boolean;
  letterSpacing?: number;
  uppercase?: boolean;
};

const DPR = 2;

export function makeLabel(text: string, options: LabelOptions = {}): LabelTexture {
  const {
    colour = '#edecf5',
    size = 28,
    weight = 500,
    mono = true,
    letterSpacing = 0,
    uppercase = false,
  } = options;

  const key = `${text}|${colour}|${size}|${weight}|${mono}|${letterSpacing}|${uppercase}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const body = uppercase ? text.toUpperCase() : text;
  const family = mono
    ? "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace"
    : "'Instrument Sans', system-ui, sans-serif";
  const font = `${weight} ${size * DPR}px ${family}`;

  const measurer = document.createElement('canvas').getContext('2d');
  if (!measurer) throw new Error('2D canvas unavailable');
  measurer.font = font;
  const spacing = letterSpacing * DPR;
  const width = Math.ceil(measurer.measureText(body).width + spacing * body.length);

  // Generous vertical padding: descenders and the odd glyph that overshoots
  // the cap height get clipped otherwise, and a clipped label reads as a
  // rendering bug rather than as a tight crop.
  const padX = Math.ceil(size * DPR * 0.3);
  const padY = Math.ceil(size * DPR * 0.42);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, width + padX * 2);
  canvas.height = Math.max(2, Math.ceil(size * DPR) + padY * 2);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  if (spacing === 0) {
    ctx.fillText(body, padX, canvas.height / 2);
  } else {
    let x = padX;
    for (const char of body) {
      ctx.fillText(char, x, canvas.height / 2);
      x += ctx.measureText(char).width + spacing;
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const label = { texture, aspect: canvas.width / canvas.height };
  cache.set(key, label);
  return label;
}
