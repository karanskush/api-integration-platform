// ValueRef is the structural half of "transient use, permanent claim, zero
// retention in DocentAPI". These tests are the enforcement: every one of them
// describes a specific way a value has historically escaped a system like this
// — serialization, spread, interpolation, a log line — and asserts it cannot.

import { describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { isValueRef, makeRef, resolveParams, TRANSIENT_PLACEHOLDER, ValueRef } from '../transient';

const SECRET = 'cus_SENTINEL_9f3a1b7c';

function ref(): ValueRef {
  const made = makeRef(SECRET);
  if (!made) throw new Error('fixture should be wrappable');
  return made;
}

describe('a ValueRef cannot be written down', () => {
  it('serializes to a placeholder, not the value', () => {
    expect(JSON.stringify({ id: ref() })).toBe(`{"id":"${TRANSIENT_PLACEHOLDER}"}`);
  });

  it('survives nesting — the whole graph is safe, not just the top level', () => {
    const payload = { steps: [{ params: { customerId: ref() } }] };
    expect(JSON.stringify(payload)).not.toContain(SENTINEL_FRAGMENT);
  });

  it('interpolates to a placeholder', () => {
    expect(`${ref()}`).toBe(TRANSIENT_PLACEHOLDER);
    expect(String(ref())).toBe(TRANSIENT_PLACEHOLDER);
  });

  // Spreading yields the reportable metadata and nothing else: `#value` is a
  // genuinely private field, so it is not an own enumerable property and cannot
  // ride along. That is the property that matters — not that the object is
  // empty, but that the VALUE never escapes this way.
  it('spreads its metadata but never its value', () => {
    const spread = { ...ref() };
    expect(spread).toEqual({ jsonType: 'string', length: SECRET.length });
    expect(JSON.stringify(spread)).not.toContain(SENTINEL_FRAGMENT);
    expect(Object.keys(ref())).not.toContain('value');
    expect(JSON.stringify(Object.values(ref()))).not.toContain(SENTINEL_FRAGMENT);
  });

  // Node prints objects through util.inspect, which reaches into private
  // fields. Without the inspect hook a bare console.error({ ref }) would put a
  // live identifier into the platform's log stream.
  it('inspects to a placeholder, so a stray console.error cannot leak it', () => {
    expect(inspect(ref())).toBe(TRANSIENT_PLACEHOLDER);
    expect(inspect({ id: ref() })).not.toContain(SENTINEL_FRAGMENT);
  });

  it('does not leak through an actual console call', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    console.error('failed for', { id: ref() });
    const logged = spy.mock.calls.flat().map((a) => inspect(a)).join(' ');
    spy.mockRestore();
    expect(logged).not.toContain(SENTINEL_FRAGMENT);
  });

  it('coerces numerically to NaN rather than to the value', () => {
    const numeric = makeRef(42)!;
    expect(Number(numeric)).toBeNaN();
    expect(`${numeric}`).toBe(TRANSIENT_PLACEHOLDER);
  });

  it('reports its shape without its content', () => {
    expect(ref().jsonType).toBe('string');
    expect(ref().length).toBe(SECRET.length);
    expect(makeRef(42)!.jsonType).toBe('number');
  });

  it('yields the value only through unwrap', () => {
    expect(ref().unwrap()).toBe(SECRET);
  });
});

// Named so the assertions above cannot pass vacuously: if SENTINEL_FRAGMENT
// were absent from the fixture, every not.toContain would trivially hold.
const SENTINEL_FRAGMENT = 'SENTINEL';

describe('the fixture really does contain the sentinel', () => {
  it('would fail the assertions above if it leaked', () => {
    expect(SECRET).toContain(SENTINEL_FRAGMENT);
    expect(JSON.stringify({ id: SECRET })).toContain(SENTINEL_FRAGMENT);
  });
});

describe('makeRef refuses what is not an identifier', () => {
  it.each([
    ['an object', { id: 'x' }],
    ['an array', ['x']],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s', (_label, value) => {
    expect(makeRef(value)).toBeNull();
  });

  it('rejects a blob too long to be an id', () => {
    expect(makeRef('x'.repeat(201))).toBeNull();
    expect(makeRef('x'.repeat(200))).not.toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(makeRef('  abc  ')!.unwrap()).toBe('abc');
  });

  it('accepts a zero, which is a legitimate identifier', () => {
    expect(makeRef(0)!.unwrap()).toBe(0);
  });
});

describe('resolveParams', () => {
  it('unwraps refs and leaves ordinary values alone', () => {
    const resolved = resolveParams({ customerId: ref(), limit: 1, status: 'active' });
    expect(resolved).toEqual({ customerId: SECRET, limit: 1, status: 'active' });
  });

  it('is the boundary: its output is live and must not be retained', () => {
    // Documented by assertion — the returned object is deliberately NOT safe,
    // which is why exactly one caller may hold it and only across one call.
    expect(JSON.stringify(resolveParams({ id: ref() }))).toContain(SENTINEL_FRAGMENT);
  });
});

describe('isValueRef', () => {
  it('narrows a ref', () => {
    expect(isValueRef(ref())).toBe(true);
  });

  it('rejects a lookalike carrying the same shape', () => {
    expect(isValueRef({ unwrap: () => SECRET, jsonType: 'string', length: 3 })).toBe(false);
  });
});
