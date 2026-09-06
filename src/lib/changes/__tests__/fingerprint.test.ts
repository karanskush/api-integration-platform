import { describe, expect, it } from 'vitest';
import type { ToolDescriptor } from '../../toolList';
import { canonicalJson, fingerprintTools, toolFingerprint } from '../fingerprint';

function tool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: 'get_pet',
    description: 'Get a pet by id',
    inputSchema: { type: 'object', properties: { petId: { type: 'string' } }, required: ['petId'] },
    annotations: { title: 'GET /pets/{petId}', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    ...overrides,
  };
}

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}',
    );
  });

  it('drops undefined members and nulls non-finite numbers', () => {
    expect(canonicalJson({ a: undefined, b: Number.NaN, c: [undefined, Infinity] })).toBe('{"b":null,"c":[null,null]}');
  });

  it('orders keys by UTF-16 code units, not locale', () => {
    // 'Z' (0x5A) sorts before 'a' (0x61) in code-unit order; a locale sort
    // would put them the other way round.
    expect(canonicalJson({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}');
  });
});

describe('toolFingerprint', () => {
  it('is independent of key order', () => {
    const a = tool();
    const b = tool({
      inputSchema: { required: ['petId'], properties: { petId: { type: 'string' } }, type: 'object' },
      annotations: { openWorldHint: true, destructiveHint: false, readOnlyHint: true, title: 'GET /pets/{petId}' },
    });
    expect(toolFingerprint(a)).toBe(toolFingerprint(b));
  });

  // The failure the September 2026 MCP drift study documented: schema moves,
  // description does not, and a client that hashes descriptions notices nothing.
  it('changes when only the input schema changes and the description is byte-identical', () => {
    const before = tool();
    const after = tool({ inputSchema: { type: 'object', properties: { petId: { type: 'integer' } }, required: ['petId'] } });
    expect(before.description).toBe(after.description);
    expect(toolFingerprint(before)).not.toBe(toolFingerprint(after));
  });

  it('changes when an annotation flips', () => {
    const before = tool();
    const after = tool({ annotations: { ...before.annotations, readOnlyHint: false } });
    expect(toolFingerprint(before)).not.toBe(toolFingerprint(after));
  });
});

describe('fingerprintTools', () => {
  it('keys perTool by name and makes the combined hash order-independent', () => {
    const a = tool({ name: 'a_tool' });
    const b = tool({ name: 'b_tool' });
    const forward = fingerprintTools([a, b]);
    const reverse = fingerprintTools([b, a]);
    expect(Object.keys(forward.perTool).sort()).toEqual(['a_tool', 'b_tool']);
    expect(forward.combined).toBe(reverse.combined);
    expect(forward.combined).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the combined hash when any one tool changes', () => {
    const base = fingerprintTools([tool({ name: 'a' }), tool({ name: 'b' })]);
    const moved = fingerprintTools([tool({ name: 'a' }), tool({ name: 'b', description: 'different' })]);
    expect(base.combined).not.toBe(moved.combined);
  });
});
