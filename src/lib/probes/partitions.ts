// The requests a careful integrator would try on day one to learn how an API
// says no — MASTER_TECHNICAL_PLAN §12.8's read-only partitions.
//
// Each partition starts from a request we could legitimately send (the shared
// filler's output) and breaks it in exactly one way, so a rejection is about
// that one thing. This is conformance discovery, not vulnerability scanning:
// values are ordinary wrong values, never payloads, and nothing here is a write.
//
// Pure. The caller sends what it gets back.

import type { Action } from '../ir';
import { isIdParam, type FillOutcome } from '../paramFill';
import { fabricateLike, isValueRef, makeRef } from '../transient';

export type PartitionKind =
  | 'omitted_required'
  | 'unknown_id'
  | 'wrong_type'
  | 'enum_violation'
  | 'malformed_format'
  | 'missing_required_header';

export type Partition = {
  kind: PartitionKind;
  field: string;
  /** May carry a ValueRef (the fabricated id); callProbe unwraps it at the wire. */
  params: Record<string, unknown>;
  /** false when the request deliberately violates the schema and Ajv must not refuse it client-side. */
  validate: boolean;
  controlBasis?: 'fabricated_like_real' | 'derived_placeholder';
};

type Schema = Record<string, unknown>;

const DEFAULT_MAX = 2;
const WRONG_TYPE_VALUE = 'docentapi-not-a-number';
const ENUM_VIOLATION_VALUE = '__docentapi_not_in_enum__';
const MALFORMED: Record<string, string> = {
  'date': 'not-a-date',
  'date-time': 'not-a-date-time',
  'uuid': 'not-a-uuid',
  'email': 'not-an-email',
  'ipv4': 'not-an-ip',
  'uri': 'not a uri',
};

function propsOf(action: Action): Record<string, Schema> {
  return (action.paramsSchema.properties ?? {}) as Record<string, Schema>;
}

function requiredNames(action: Action): string[] {
  const required = action.paramsSchema.required;
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : [];
}

function placement(schema: Schema | undefined): string {
  return typeof schema?.['x-docentapi-in'] === 'string' ? (schema['x-docentapi-in'] as string) : 'query';
}

function typeOf(schema: Schema | undefined): string | undefined {
  const raw = schema?.type;
  if (Array.isArray(raw)) return raw.find((t) => typeof t === 'string' && t !== 'null') as string | undefined;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * The fabricated id for a path parameter: shaped like the real one when the
 * fill came from the pool (a format-valid decoy the API must actually look up),
 * else a placeholder shaped by the parameter's type. Never the real value.
 */
function unknownIdFor(value: unknown, schema: Schema | undefined, runId?: string): { value: unknown; basis: Partition['controlBasis'] } {
  if (isValueRef(value)) return { value: fabricateLike(value), basis: 'fabricated_like_real' };
  const fromExample = typeof value === 'string' || typeof value === 'number' ? makeRef(value) : null;
  if (fromExample) return { value: fabricateLike(fromExample), basis: 'derived_placeholder' };
  const t = typeOf(schema);
  if (t === 'integer' || t === 'number') return { value: 987654321, basis: 'derived_placeholder' };
  return { value: `docentapi-missing-${runId ?? 'run'}`, basis: 'derived_placeholder' };
}

export function buildNegativePartitions(
  action: Action,
  base: FillOutcome,
  opts: { max?: number; runId?: string } = {},
): Partition[] {
  if (!base.ok) return [];
  const max = opts.max ?? DEFAULT_MAX;
  const props = propsOf(action);
  const required = requiredNames(action);
  const present = Object.keys(base.params).filter((k) => k in props);
  const out: Partition[] = [];
  const add = (p: Partition) => {
    if (out.length < max && !out.some((o) => o.kind === p.kind)) out.push(p);
  };
  const clone = () => ({ ...base.params });

  // 1. A required parameter left out. Never a path parameter — the URL would
  //    have a hole in it and nothing would be sent.
  const omittable = required.find((k) => present.includes(k) && placement(props[k]) !== 'path' && placement(props[k]) !== 'header');
  if (omittable) {
    const params = clone();
    delete params[omittable];
    add({ kind: 'omitted_required', field: omittable, params, validate: false });
  }

  // 2. An identifier no record has. Doubles as the negative control for the
  //    positive read of the same operation.
  const idKey = present.find((k) => placement(props[k]) === 'path') ?? present.find((k) => isIdParam(k, props[k]));
  if (idKey) {
    const { value, basis } = unknownIdFor(base.params[idKey], props[idKey], opts.runId);
    add({ kind: 'unknown_id', field: idKey, params: { ...clone(), [idKey]: value }, validate: true, controlBasis: basis });
  }

  // 3. A typed query parameter sent as prose.
  const typed = present.find((k) => placement(props[k]) === 'query' && ['integer', 'number', 'boolean'].includes(typeOf(props[k]) ?? ''));
  if (typed) add({ kind: 'wrong_type', field: typed, params: { ...clone(), [typed]: WRONG_TYPE_VALUE }, validate: false });

  // 4. A value outside a declared closed set.
  const enumerated = present.find((k) => placement(props[k]) === 'query' && Array.isArray(props[k]?.enum));
  if (enumerated) add({ kind: 'enum_violation', field: enumerated, params: { ...clone(), [enumerated]: ENUM_VIOLATION_VALUE }, validate: false });

  // 5. A formatted string that is not in the format.
  const formatted = present.find((k) => placement(props[k]) === 'query' && typeof props[k]?.format === 'string' && props[k].format in MALFORMED);
  if (formatted) {
    add({ kind: 'malformed_format', field: formatted, params: { ...clone(), [formatted]: MALFORMED[props[formatted].format as string] }, validate: false });
  }

  // 6. A required header left out.
  const header = required.find((k) => present.includes(k) && placement(props[k]) === 'header');
  if (header) {
    const params = clone();
    delete params[header];
    add({ kind: 'missing_required_header', field: header, params, validate: false });
  }

  return out;
}
