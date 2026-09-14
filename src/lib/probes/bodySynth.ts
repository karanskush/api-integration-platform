// The minimal valid body for a create, and the one-field change for an update.
//
// Rules, in order of what they protect:
//   * required properties only — the smallest object the spec says is valid;
//   * every string we invent is tagged `docentapi-probe-<runId>` so it is
//     recognisable in the provider's own data and logs;
//   * an enum picks the member least likely to mean "go live" — never
//     `active`, `published`, `sent`, `live`, `public` when another exists;
//   * a URL is never invented (only an explicit example may supply one), and
//     neither is a regex match — the synthesis fails closed instead;
//   * readOnly properties are the API's to assign and are skipped.
//
// Pure. The runner sends what it gets back.

import { mergeCombinators } from '../fieldMap';
import type { Action } from '../ir';

type Schema = Record<string, unknown>;

export type BodyFailure = 'no_body' | 'url_required' | 'pattern_required' | 'unsynthesizable';
export type BodyOutcome = { ok: true; body: unknown; tagged: string[] } | { ok: false; reason: BodyFailure };

const MAX_DEPTH = 6;
const URL_FORMATS = new Set(['uri', 'url', 'uri-reference', 'iri', 'iri-reference', 'uri-template', 'hostname', 'ipv4', 'ipv6']);
const CONSEQUENTIAL_MEMBER = /publish|active|sent|live|public|approved|paid|complete|final/i;
const UPDATED_SUFFIX = '-updated';

function asSchema(v: unknown): Schema | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Schema) : null;
}

function typeOf(schema: Schema): string {
  const raw = schema.type;
  const declared = Array.isArray(raw) ? raw.find((t) => typeof t === 'string' && t !== 'null') : raw;
  if (typeof declared === 'string') return declared;
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return 'unknown';
}

export function bodySchemaOf(action: Action): Schema | null {
  const props = (action.paramsSchema.properties ?? {}) as Record<string, Schema>;
  const body = Object.values(props).find((p) => p?.['x-docentapi-in'] === 'body');
  return body ? (mergeCombinators(body as never) as Schema) : null;
}

export function bodyParamName(action: Action): string | null {
  const props = (action.paramsSchema.properties ?? {}) as Record<string, Schema>;
  return Object.keys(props).find((k) => props[k]?.['x-docentapi-in'] === 'body') ?? null;
}

function pickEnum(values: unknown[]): unknown {
  const strings = values.filter((v): v is string => typeof v === 'string');
  return strings.find((v) => !CONSEQUENTIAL_MEMBER.test(v)) ?? values[0];
}

class Refused extends Error {
  constructor(readonly reason: BodyFailure) {
    super(reason);
  }
}

function synth(raw: Schema, name: string, tag: string, tagged: string[], depth: number): unknown {
  const schema = mergeCombinators(raw as never) as Schema;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return pickEnum(schema.enum);

  switch (typeOf(schema)) {
    case 'string': {
      const format = typeof schema.format === 'string' ? schema.format : undefined;
      if (format && URL_FORMATS.has(format)) throw new Refused('url_required');
      if (typeof schema.pattern === 'string') throw new Refused('pattern_required');
      if (format === 'email') {
        const v = `${tag}@example.invalid`;
        tagged.push(name);
        return v;
      }
      if (format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (format === 'date') return '2000-01-01';
      if (format === 'date-time') return '2000-01-01T00:00:00Z';
      let v = tag;
      if (typeof schema.maxLength === 'number' && v.length > schema.maxLength) v = v.slice(0, Math.max(1, schema.maxLength));
      if (typeof schema.minLength === 'number' && v.length < schema.minLength) v = v.padEnd(schema.minLength, 'x');
      tagged.push(name);
      return v;
    }
    case 'integer':
    case 'number': {
      let v = 1;
      if (typeof schema.minimum === 'number') v = schema.minimum + (schema.exclusiveMinimum === true ? 1 : 0);
      if (typeof schema.exclusiveMinimum === 'number') v = schema.exclusiveMinimum + 1;
      if (typeof schema.maximum === 'number' && v > schema.maximum) v = schema.maximum;
      return typeOf(schema) === 'integer' ? Math.round(v) : v;
    }
    case 'boolean':
      return false;
    case 'array': {
      const items = asSchema(schema.items);
      const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
      if (!items || depth >= MAX_DEPTH) {
        if (min > 0) throw new Refused('unsynthesizable');
        return [];
      }
      if (min === 0) return [];
      return Array.from({ length: Math.min(min, 3) }, (_, i) => synth(items, `${name}[${i}]`, tag, tagged, depth + 1));
    }
    case 'object': {
      const props = asSchema(schema.properties) as Record<string, Schema> | null;
      if (!props || depth >= MAX_DEPTH) return {};
      const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((r): r is string => typeof r === 'string') : [];
      const out: Record<string, unknown> = {};
      for (const key of required) {
        const child = asSchema(props[key]);
        if (!child) throw new Refused('unsynthesizable');
        if (child.readOnly === true) continue;
        out[key] = synth(child, key, tag, tagged, depth + 1);
      }
      return out;
    }
    default:
      throw new Refused('unsynthesizable');
  }
}

export function synthesizeCreateBody(action: Action, runId: string): BodyOutcome {
  const schema = bodySchemaOf(action);
  if (!schema) return { ok: false, reason: 'no_body' };
  const tagged: string[] = [];
  try {
    const body = synth(schema, 'body', `docentapi-probe-${runId}`, tagged, 0);
    return { ok: true, body, tagged };
  } catch (err) {
    return { ok: false, reason: err instanceof Refused ? err.reason : 'unsynthesizable' };
  }
}

export type UpdateOutcome = { ok: true; body: unknown; field: string; marker: string } | { ok: false; reason: 'no_body' | 'no_optional_field' };

// One optional, writable, free-form string changed to a recognisable value. A
// PUT replaces the whole object, so it re-sends the create body with that one
// change; a PATCH sends only the change.
export function synthesizeUpdateBody(update: Action, createBody: unknown, runId: string): UpdateOutcome {
  const schema = bodySchemaOf(update);
  if (!schema) return { ok: false, reason: 'no_body' };
  const props = asSchema(schema.properties) as Record<string, Schema> | null;
  if (!props) return { ok: false, reason: 'no_optional_field' };
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const field = Object.keys(props).find((k) => {
    const p = mergeCombinators(props[k] as never) as Schema;
    return (
      typeOf(p) === 'string' &&
      p.readOnly !== true &&
      p.enum === undefined &&
      p.pattern === undefined &&
      p.format === undefined &&
      p.const === undefined &&
      !/(^|[_-])(id|key|code|token|slug|url|uri|email)$/i.test(k)
    );
  });
  // Fall back to a required free-form string: a PUT must carry it anyway.
  const chosen = field ?? Object.keys(props).find((k) => required.has(k) && typeOf(mergeCombinators(props[k] as never) as Schema) === 'string');
  if (!chosen) return { ok: false, reason: 'no_optional_field' };
  let marker = `docentapi-probe-${runId}${UPDATED_SUFFIX}`;
  const p = props[chosen];
  if (typeof p.maxLength === 'number' && marker.length > p.maxLength) marker = marker.slice(0, Math.max(1, p.maxLength));
  const base = update.method.toUpperCase() === 'PUT' && typeof createBody === 'object' && createBody !== null ? { ...(createBody as Record<string, unknown>) } : {};
  return { ok: true, body: { ...base, [chosen]: marker }, field: chosen, marker };
}
