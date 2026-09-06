// Content fingerprints for MCP tool descriptors.
//
// Why this exists: a September 2026 crawl of 248 public MCP servers found 17
// tools whose input schema or annotations changed while the description stayed
// byte-identical — and MCP clients approve a tool once, then never re-prompt.
// DocentAPI's tools are derived from spec versions, so a spec change can
// silently reshape a tool an agent already trusts. Hashing the FULL descriptor
// (name, description, inputSchema, annotations) makes that change detectable:
// the diff engine lists which tools changed between versions, and
// docentapi_check_freshness returns the combined hash so an agent can compare
// it with what it cached.
//
// Canonicalization follows RFC 8785 (JCS) in the parts that matter for JSON
// produced by this codebase: keys sorted recursively by UTF-16 code units, no
// whitespace, undefined members dropped. Number formatting is JavaScript's own
// (ES6 Number::toString), which is what JCS specifies; the one JCS case this
// does not reproduce — re-serializing a parsed third-party float whose source
// text was not in canonical form — cannot occur here because every value
// hashed is a JS value, never raw JSON text.

import { createHash } from 'node:crypto';
import type { ToolDescriptor } from '../toolList';

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      break;
    default:
      // undefined, function, symbol, bigint: not representable — JSON.stringify
      // would drop or throw; a stable 'null' keeps the hash total.
      return 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const record = value as Record<string, unknown>;
  // Default string comparison IS UTF-16 code-unit order, which is what JCS
  // specifies (RFC 8785 §3.2.3). No localeCompare here — that would vary.
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function toolFingerprint(descriptor: ToolDescriptor): string {
  return sha256(
    canonicalJson({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      annotations: descriptor.annotations,
    }),
  );
}

export type ToolFingerprints = {
  perTool: Record<string, string>;
  // Hash over the name-sorted [name, hash] pairs — independent of the order
  // tools/list happens to emit them in.
  combined: string;
};

export function fingerprintTools(descriptors: ToolDescriptor[]): ToolFingerprints {
  const perTool: Record<string, string> = {};
  for (const d of descriptors) perTool[d.name] = toolFingerprint(d);
  const pairs = Object.keys(perTool)
    .sort()
    .map((name) => [name, perTool[name]]);
  return { perTool, combined: sha256(canonicalJson(pairs)) };
}
