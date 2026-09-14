// How a probe fills an operation's parameters when it has no owner-supplied
// values — the one predicate behind "can this read be called at all".
//
// Before this existed, five probes each asked the question their own way, and
// all five read only `examples[0].params`, which the importer populates from an
// explicit `example` in the spec and nothing else. A spec that declares
// `default: available` and `enum: [available, pending, sold]` but no `example`
// — the Swagger Petstore, and most hand-written specs — made every read
// uncallable, and eight nightly production runs made zero live requests.
//
// THE LADDER. A value comes from the most authoritative place that has one:
//
//   example        the documented example params the importer captured
//   schema_example an `example` on the parameter's own schema
//   default        what the spec says the API assumes when the value is absent
//   const          the only value the spec allows
//   enum           the first member of a declared closed set
//   harvested      a real identifier read out of a list response this run
//                  (probes/harvest.ts), carried as a ValueRef, never a string
//   created        the identifier of a fixture the write runner made this run
//   derived        a placeholder shaped by the declared type/format/bounds
//
// Everything above `derived` is the provider's own statement or the provider's
// own data; `derived` is ours, tagged `docentapi-probe-<runId>` so it is
// recognisable in any access log. A derived value is never used where it
// would address a record — a path parameter or an id-shaped name — unless a
// caller opts in, because a guessed id produces a 404 that says nothing about
// the API and would be recorded as if it did.
//
// NEVER PERSISTED. Fills are computed at probe time and discarded. The tool
// schemas and examples an agent sees stay exactly what the spec declared: an
// invented value must not become a published claim (the canary's 2026-09-06
// lesson about auto-patching a schema from an observation).
//
// Pure: no I/O, no clock beyond the deterministic option, no DB.

import { randomUUID } from 'node:crypto';
import { mergeCombinators } from './fieldMap';
import type { Action } from './ir';
import { paginationFor } from './pagination';
import { isIdLike } from './resource';
import type { ValueRef } from './transient';

export type FillSource =
  | 'example'
  | 'schema_example'
  | 'default'
  | 'const'
  | 'enum'
  | 'harvested'
  | 'created'
  | 'derived';

export type FillFailure =
  | 'unfillable_required'
  | 'placeholder_id_refused'
  | 'url_like_value'
  | 'value_too_long'
  | 'pattern_unsatisfiable';

export type FillOutcome =
  | {
      ok: true;
      /** May contain ValueRefs for pooled values — resolve with transient.resolveParams() right before the call. */
      params: Record<string, unknown>;
      sources: Record<string, FillSource>;
      /** The least authoritative rung used, so a caller can refuse e.g. `derived`. */
      weakest: FillSource | null;
    }
  | { ok: false; reason: FillFailure; missing: string[] };

export type PoolEntry = { ref: ValueRef; source: 'harvested' | 'created' };

/** Identifiers available to fill id-shaped parameters, keyed by consumer tool and argument. */
export type ValuePool = {
  get(consumerTool: string, arg: string): PoolEntry[];
};

export type MutableValuePool = ValuePool & {
  add(consumerTool: string, arg: string, entries: PoolEntry[]): void;
  size(): number;
  clear(): void;
};

export function createValuePool(): MutableValuePool {
  const map = new Map<string, PoolEntry[]>();
  const key = (tool: string, arg: string) => `${tool}|${arg}`;
  return {
    get: (tool, arg) => map.get(key(tool, arg)) ?? [],
    add: (tool, arg, entries) => {
      if (!entries.length) return;
      map.set(key(tool, arg), [...(map.get(key(tool, arg)) ?? []), ...entries]);
    },
    size: () => map.size,
    clear: () => map.clear(),
  };
}

export type FillOptions = {
  /** An argument the caller supplies itself (a chain consumer's id); left out of the fill. */
  exclude?: string;
  /** Harvested/created identifiers. Absent means spec-only. */
  pool?: ValuePool;
  /** Never consult the pool and keep derived values stable across runs (the canary). */
  deterministic?: boolean;
  /** Allow a derived placeholder for a path or id-shaped parameter. Default false. */
  allowPlaceholderIds?: boolean;
  /** Page size to request when the operation paginates. Default 1. */
  pageSize?: number;
  /** Which optional parameters to include. Default: only the page-size parameter. */
  includeOptional?: 'none' | 'pagination_only';
  /** Tags derived strings so they are recognisable in a provider's logs. */
  runId?: string;
};

export type ParamFiller = (action: Action, opts?: FillOptions) => FillOutcome;

type Schema = Record<string, unknown>;

const MAX_SCALAR_CHARS = 200;
const MAX_DEPTH = 6;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const URL_FORMATS = new Set(['uri', 'url', 'uri-reference', 'iri', 'iri-reference', 'uri-template', 'hostname', 'ipv4', 'ipv6']);
const DETERMINISTIC_UUID = '00000000-0000-4000-8000-000000000000';
const DETERMINISTIC_DATE = '2000-01-01';

const SOURCE_RANK: Record<FillSource, number> = {
  example: 0,
  schema_example: 1,
  default: 2,
  const: 3,
  enum: 4,
  harvested: 5,
  created: 6,
  derived: 7,
};

function asSchema(value: unknown): Schema | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Schema) : null;
}

function propsOf(action: Action): Record<string, Schema> {
  return (asSchema(action.paramsSchema.properties) ?? {}) as Record<string, Schema>;
}

function requiredNames(action: Action): string[] {
  const required = action.paramsSchema.required;
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : [];
}

function typeOf(schema: Schema): string {
  const raw = schema.type;
  const declared = Array.isArray(raw) ? raw.find((t) => typeof t === 'string' && t !== 'null') : raw;
  if (typeof declared === 'string') return declared;
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return 'unknown';
}

/** A path parameter, or a name that ends in an id token (`petId`, `customer_id`, `id`). */
export function isIdParam(name: string, schema: Schema | undefined): boolean {
  return schema?.['x-docentapi-in'] === 'path' || isIdLike(name);
}

// The provider's own statement about a value, in order of authority.
function scalarDeclared(schema: Schema | undefined): { value: unknown; source: FillSource } | undefined {
  if (!schema) return undefined;
  if (schema.example !== undefined) return { value: schema.example, source: 'schema_example' };
  if (schema.default !== undefined) return { value: schema.default, source: 'default' };
  if (schema.const !== undefined) return { value: schema.const, source: 'const' };
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return { value: schema.enum[0], source: 'enum' };
  return undefined;
}

function declared(action: Action, name: string): { value: unknown; source: FillSource } | undefined {
  const prop = propsOf(action)[name];
  if (!prop) return undefined;
  const direct = scalarDeclared(prop);
  if (direct) return direct;
  // An ARRAY parameter declares its values one level down, on `items`. Swagger
  // 2 specs do this constantly — the Petstore's findPetsByStatus is
  // `type: array` with `items.enum` and `items.default`. One element is enough.
  if (typeOf(prop) === 'array') {
    const item = scalarDeclared(asSchema(prop.items) ?? undefined);
    if (item) return { value: [item.value], source: item.source };
  }
  return undefined;
}

/** The value the spec itself declares for a parameter, or undefined. Kept for lineagePlan. */
export function declaredValueFor(action: Action, name: string): unknown {
  return declared(action, name)?.value;
}

type DeriveOptions = { deterministic?: boolean; runId?: string };

function tag(opts: DeriveOptions): string {
  return `docentapi-probe-${opts.runId ?? 'run'}`;
}

function deriveString(schema: Schema, opts: DeriveOptions): string | undefined {
  const format = typeof schema.format === 'string' ? schema.format : undefined;
  if (format && URL_FORMATS.has(format)) return undefined; // never invent a URL
  if (typeof schema.pattern === 'string') return undefined; // never invent a regex match
  if (format === 'uuid') return opts.deterministic ? DETERMINISTIC_UUID : randomUUID();
  if (format === 'date') return opts.deterministic ? DETERMINISTIC_DATE : new Date().toISOString().slice(0, 10);
  if (format === 'date-time') return opts.deterministic ? `${DETERMINISTIC_DATE}T00:00:00Z` : new Date().toISOString();
  if (format === 'email') return `${tag(opts)}@example.invalid`;

  let value = tag(opts);
  const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
  const minLength = typeof schema.minLength === 'number' ? schema.minLength : undefined;
  if (maxLength !== undefined && value.length > maxLength) value = value.slice(0, Math.max(1, maxLength));
  if (minLength !== undefined && value.length < minLength) value = value.padEnd(minLength, 'x');
  return value;
}

function deriveNumber(schema: Schema, integer: boolean): number {
  let value = 1;
  if (typeof schema.minimum === 'number') value = schema.minimum + (schema.exclusiveMinimum === true ? 1 : 0);
  if (typeof schema.exclusiveMinimum === 'number') value = schema.exclusiveMinimum + 1;
  if (typeof schema.maximum === 'number' && value > schema.maximum) value = schema.maximum;
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) value = schema.exclusiveMaximum - 1;
  return integer ? Math.round(value) : value;
}

/**
 * A placeholder shaped by the schema alone. Returns undefined — fails closed —
 * for anything this refuses to invent: URLs, regex-constrained strings, unknown
 * types, or an object whose required child cannot be derived.
 */
export function deriveValue(name: string, raw: Schema, opts: DeriveOptions = {}, depth = 0): unknown {
  const schema = mergeCombinators(raw as never) as Schema;
  const stated = scalarDeclared(schema);
  if (stated) return stated.value;

  switch (typeOf(schema)) {
    case 'string':
      return deriveString(schema, opts);
    case 'integer':
      return deriveNumber(schema, true);
    case 'number':
      return deriveNumber(schema, false);
    case 'boolean':
      return false;
    case 'array': {
      const items = asSchema(schema.items);
      if (!items || depth >= MAX_DEPTH) return undefined;
      const item = deriveValue(name, items, opts, depth + 1);
      return item === undefined ? undefined : [item];
    }
    case 'object': {
      const props = asSchema(schema.properties) as Record<string, Schema> | null;
      if (!props || depth >= MAX_DEPTH) return undefined;
      const required = Array.isArray(schema.required)
        ? (schema.required as unknown[]).filter((r): r is string => typeof r === 'string')
        : [];
      const out: Record<string, unknown> = {};
      for (const key of required) {
        const child = asSchema(props[key]);
        if (!child) return undefined;
        if (child.readOnly === true) continue;
        const value = deriveValue(key, child, opts, depth + 1);
        if (value === undefined) return undefined;
        out[key] = value;
      }
      return out;
    }
    default:
      return undefined;
  }
}

function failureFor(schema: Schema | undefined): FillFailure {
  if (schema && typeof schema.pattern === 'string') return 'pattern_unsatisfiable';
  const format = typeof schema?.format === 'string' ? schema.format : undefined;
  if (format && URL_FORMATS.has(format)) return 'url_like_value';
  return 'unfillable_required';
}

// A value we produced ourselves must be a modest scalar and must never look
// like a URL: the request's host is fixed by the base URL, and a value that
// reads as an address is exactly the thing the chain runner refuses to follow.
function checkOurValue(value: unknown): FillFailure | null {
  if (typeof value === 'string') {
    if (value.length > MAX_SCALAR_CHARS) return 'value_too_long';
    if (URL_LIKE.test(value)) return 'url_like_value';
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const failure = checkOurValue(item);
      if (failure) return failure;
    }
  }
  return null;
}

function clampSize(schema: Schema | undefined, wanted: number): unknown {
  let size = Math.max(1, Math.floor(wanted));
  if (schema) {
    if (typeof schema.minimum === 'number' && size < schema.minimum) size = schema.minimum;
    if (typeof schema.maximum === 'number' && size > schema.maximum) size = schema.maximum;
    if (typeOf(schema) === 'string') return String(size);
  }
  return size;
}

export function fillParams(action: Action, opts: FillOptions = {}): FillOutcome {
  const props = propsOf(action);
  const example = action.examples[0]?.params ?? {};
  const params: Record<string, unknown> = {};
  const sources: Record<string, FillSource> = {};

  // Only parameters the schema declares survive: validateParams runs with
  // additionalProperties:false, so anything else would be rejected client-side.
  for (const [key, value] of Object.entries(example)) {
    if (key === opts.exclude || !(key in props)) continue;
    params[key] = value;
    sources[key] = 'example';
  }

  // One page is all any probe needs, and a cursor or offset copied from an
  // example addresses a position in someone else's listing. Clamp and strip.
  const pagination = paginationFor(action);
  for (const key of [pagination.cursorParam, pagination.pageParam, pagination.offsetParam]) {
    if (key && key !== opts.exclude) {
      delete params[key];
      delete sources[key];
    }
  }
  const includeOptional = opts.includeOptional ?? 'pagination_only';
  if (pagination.sizeParam && pagination.sizeParam in props && pagination.sizeParam !== opts.exclude) {
    const isRequired = requiredNames(action).includes(pagination.sizeParam);
    if (isRequired || includeOptional === 'pagination_only') {
      params[pagination.sizeParam] = clampSize(props[pagination.sizeParam], opts.pageSize ?? 1);
      sources[pagination.sizeParam] = params[pagination.sizeParam] === example[pagination.sizeParam] ? 'example' : 'derived';
    }
  }

  const missing: string[] = [];
  let failure: FillFailure | null = null;
  const fail = (name: string, reason: FillFailure) => {
    missing.push(name);
    failure ??= reason;
  };

  for (const name of requiredNames(action)) {
    if (name === opts.exclude || name in params) continue;
    const schema = props[name];
    if (!schema) {
      fail(name, 'unfillable_required');
      continue;
    }

    const stated = declared(action, name);
    if (stated) {
      params[name] = stated.value;
      sources[name] = stated.source;
      continue;
    }

    if (isIdParam(name, schema)) {
      const entries = opts.deterministic ? [] : (opts.pool?.get(action.name, name) ?? []);
      const entry = entries[0];
      if (entry) {
        params[name] = entry.ref;
        sources[name] = entry.source;
        continue;
      }
      if (!opts.allowPlaceholderIds) {
        fail(name, 'placeholder_id_refused');
        continue;
      }
    }

    const value = deriveValue(name, schema, { deterministic: opts.deterministic, runId: opts.runId });
    if (value === undefined) {
      fail(name, failureFor(schema));
      continue;
    }
    const bad = checkOurValue(value);
    if (bad) {
      fail(name, bad);
      continue;
    }
    params[name] = value;
    sources[name] = 'derived';
  }

  if (failure) return { ok: false, reason: failure, missing };

  let weakest: FillSource | null = null;
  for (const source of Object.values(sources)) {
    if (!weakest || SOURCE_RANK[source] > SOURCE_RANK[weakest]) weakest = source;
  }
  return { ok: true, params, sources, weakest };
}

/** The single predicate that replaces the per-probe "is there an example for everything?" checks. */
export function canFill(action: Action, opts: FillOptions = {}): boolean {
  return fillParams(action, opts).ok;
}

/** Fills from the spec alone: no pool, whatever the options say. */
export const specOnlyFiller: ParamFiller = (action, opts = {}) => fillParams(action, { ...opts, pool: undefined });

/** Fills from the spec and the given pool of harvested/created identifiers. */
export function pooledFiller(pool: ValuePool): ParamFiller {
  return (action, opts = {}) => fillParams(action, { pool, ...opts });
}

/**
 * A producer's parameters for a chain or a harvest: deterministic, one row,
 * no cursor. Callers check canFill() first; an unfillable producer yields {}.
 */
export function producerParamsFor(action: Action, opts: FillOptions = {}): Record<string, unknown> {
  const outcome = fillParams(action, { deterministic: true, pageSize: 1, ...opts });
  return outcome.ok ? outcome.params : {};
}
