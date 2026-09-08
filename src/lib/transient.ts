// A value that can be USED but not written down.
//
// Executed Lineage has to read an identifier out of one operation's response
// and put it into the next operation's request — otherwise it cannot verify
// that the two are really connected. That is in direct tension with the rule
// the rest of this codebase holds absolutely: no code path copies a value out
// of a response body. changes/observation.ts states it, and
// operation_observations enforces it structurally by having nowhere to put one.
//
// The executor cannot be lossy the way inferShape() is — it needs the actual
// value to make the next call. So the enforcement moves up one level: the value
// exists in memory for the duration of a run and is physically unable to be
// serialized, spread, interpolated, or logged.
//
//   JSON.stringify({ ref })      -> {"ref":"[transient]"}
//   `${ref}`                     -> [transient]
//   { ...ref }                   -> {}            (a #private field never spreads)
//   console.error({ ref })       -> [transient]   (inspect hook below)
//   Object.keys(ref)             -> []
//
// unwrap() is the single audited accessor, and it is called in exactly one
// place: the frame immediately before invokeAction. Grep for it — if it appears
// anywhere else, the invariant has been broken.
//
// The honest claim this supports is "zero retention IN DOCENTAPI", not "zero
// retention". The value still travels into a URL and therefore into the
// provider's own access log, attributed to the owner's key. Anything stronger
// would be an overclaim.

// The longest plausible identifier. Anything beyond this is not an id being
// passed between two operations — it is a blob, and refusing it keeps a large
// response field from being carried around a run.
const MAX_VALUE_LENGTH = 200;

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export const TRANSIENT_PLACEHOLDER = '[transient]';

export class ValueRef {
  // A genuinely private field, not a convention: `#value` is invisible to
  // Object.keys, spread, JSON.stringify and structuredClone. A `private`
  // TypeScript modifier would only be a compile-time promise and would still
  // serialize at runtime, which is the exact failure this class exists to make
  // impossible.
  readonly #value: string | number;

  /** Reportable metadata. Never the value. */
  readonly jsonType: 'string' | 'number';
  readonly length: number;

  constructor(value: string | number) {
    this.#value = value;
    this.jsonType = typeof value === 'number' ? 'number' : 'string';
    this.length = String(value).length;
  }

  /** The one audited accessor. Call it only immediately before an outbound request. */
  unwrap(): string | number {
    return this.#value;
  }

  toJSON(): string {
    return TRANSIENT_PLACEHOLDER;
  }

  toString(): string {
    return TRANSIENT_PLACEHOLDER;
  }

  // Node prints objects through util.inspect, which reaches into private
  // fields. Without this hook a bare console.error({ ref }) would put a live
  // identifier into the platform's log stream — the classic way a value escapes
  // (vault.ts makes the same point about error strings).
  [INSPECT](): string {
    return TRANSIENT_PLACEHOLDER;
  }

  // Covers `+ref` and other numeric coercions, which would otherwise bypass
  // toString for a numeric id.
  [Symbol.toPrimitive](hint: string): string | number {
    return hint === 'number' ? Number.NaN : TRANSIENT_PLACEHOLDER;
  }

  get [Symbol.toStringTag](): string {
    return 'ValueRef';
  }
}

/**
 * Wraps a candidate value, or returns null when it is not usable as an
 * identifier to pass between two operations.
 *
 * Rejects rather than coerces: an object, an array, a boolean, an empty string
 * or an over-long blob is not an id, and silently stringifying one would send a
 * meaningless request and then record its failure as evidence about the API.
 */
export function makeRef(value: unknown): ValueRef | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new ValueRef(value) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) return null;
  return new ValueRef(trimmed);
}

/** True when the value is a ValueRef. Narrow before calling unwrap(). */
export function isValueRef(value: unknown): value is ValueRef {
  return value instanceof ValueRef;
}

/**
 * Resolves a parameter map for an outbound call, unwrapping any refs.
 *
 * This is the ONLY place unwrap() is called outside the class, and it exists so
 * there is exactly one auditable boundary rather than a scattering of them. The
 * returned object holds live values and must be passed straight to invokeAction
 * and never retained, logged, or returned to a caller.
 */
export function resolveParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = isValueRef(value) ? value.unwrap() : value;
  }
  return out;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SHAPE = /^[0-9a-f]+$/i;
const DIGITS_SHAPE = /^\d+$/;
// Stripe-style `cus_ABC123`, GitHub-style `gh-123`: the prefix is often what a
// provider validates before it looks anything up.
const PREFIXED_SHAPE = /^([A-Za-z]{2,10}[_-])(.+)$/;

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomFrom(charset: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += charset[Math.floor(Math.random() * charset.length)];
  return out;
}

function randomUuid(): string {
  const hex = () => randomFrom('0123456789abcdef', 4);
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

/**
 * A fabricated value shaped like the real one — the negative control.
 *
 * The control's job is to prove the endpoint actually reads the identifier
 * rather than answering 2xx to anything (lineageVerdict.ts). For that it has to
 * be FORMAT-VALID: a provider that rejects a malformed id with a 400 before
 * looking anything up would make every control non-2xx and every chain look
 * discriminating, which would defeat the check it exists to perform. So this
 * mirrors the real value's shape — uuid, hex, digits, or a validated prefix —
 * and randomises only the part that identifies a record.
 *
 * This is the second and last place unwrap() is called. It reads the shape and
 * returns a NEW ref; the real value never leaves this function, and the control
 * is itself transient so it cannot be written down either.
 */
export function fabricateLike(ref: ValueRef): ValueRef {
  const real = ref.unwrap();

  if (typeof real === 'number') {
    // Same digit-length, so a numeric-range validator still accepts it, but
    // vanishingly unlikely to name a real record.
    const digits = Math.max(String(Math.trunc(Math.abs(real))).length, 6);
    const lower = 10 ** (digits - 1);
    return new ValueRef(lower + Math.floor(Math.random() * (lower * 9 - 1)));
  }

  if (UUID_SHAPE.test(real)) return new ValueRef(randomUuid());
  if (DIGITS_SHAPE.test(real)) return new ValueRef(randomFrom('123456789', real.length));
  if (HEX_SHAPE.test(real)) return new ValueRef(randomFrom('0123456789abcdef', real.length));

  const prefixed = PREFIXED_SHAPE.exec(real);
  if (prefixed) return new ValueRef(`${prefixed[1]}${randomFrom(ALPHANUM, prefixed[2].length)}`);

  return new ValueRef(randomFrom(ALPHANUM, real.length));
}
