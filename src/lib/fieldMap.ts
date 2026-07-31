// Flattens an action's schemas into a per-field inventory.
//
// Everything above this file reasons at OPERATION granularity: which endpoint,
// which parameters, which safety class. The two questions that matter most to
// somebody actually wiring up an integration live one level below that — "what
// exactly can I send here" and "where does this particular value come from" —
// and neither can be answered from a nested JSON Schema blob. This module turns
// that blob into a flat, addressable list of fields.
//
// Pure and synchronous, in the same shape as scorePreview.ts: no I/O, no DB, no
// network. That is what lets it serve ephemeral imports (which have no database
// row at all) identically to persistent ones.
//
// Two properties are load-bearing:
//
//   1. PATHS ARE ADDRESSABLE. `body.customer.address.line1` is a name you can
//      hand back to another tool. The existing declaredFields() in
//      advisor/sequence.ts collapses everything to a lowercased Set of leaf
//      names, so `data.id` and `items[].id` become the same string and neither
//      can be pointed at.
//
//   2. TRUNCATION IS EXPLICIT. declaredFields() silently stops at depth 3 and
//      getEndpointSchema echoes raw schemas with no cap at all. Both are quiet
//      failures: the caller cannot tell "this API has no such field" from "we
//      stopped looking". Everything here reports `truncated` when it stops.

import type { Action, ImportRecord, JSONSchema } from './ir';

export type FieldLocation = 'path' | 'query' | 'header' | 'body' | 'response' | 'error';

// Where a value a caller must supply actually comes from. This is the honest
// core of the whole feature: for a signup endpoint the correct answer to "where
// does username come from?" is `caller_supplied` — nowhere in the API produces
// it, a human invents it. A tool that answers that with a fabricated source is
// worse than one that stays quiet.
export type FieldOrigin =
  | 'server_generated' // readOnly: the API produces it, you must not send it
  | 'constant' // const: exactly one legal value
  | 'enum_constrained' // pick from a fixed list, which we can show you
  | 'produced_by_api' // another operation's response yields it (lineage.ts)
  | 'caller_supplied'; // genuinely originates with the caller

// The same five as a runtime value, ordered the way a caller meets them:
// what the server owns, what is fixed, what another call yields, what a list
// constrains, and what is genuinely theirs to choose.
//
// The `satisfies Record<FieldOrigin, 0>` is the point of the indirection —
// it is an exhaustiveness check, so adding a member to FieldOrigin without
// adding it here fails the build rather than silently shortening any list
// built from this.
export const FIELD_ORIGINS = Object.keys({
  server_generated: 0,
  constant: 0,
  produced_by_api: 0,
  enum_constrained: 0,
  caller_supplied: 0,
} satisfies Record<FieldOrigin, 0>) as FieldOrigin[];

export type FieldNode = {
  path: string; // 'body.customer.address.line1', 'response.data[].id'
  name: string; // leaf name only: 'line1'
  location: FieldLocation;
  type: string;
  format?: string;
  title?: string; // survives sanitization; the strongest type-identity signal
  required: boolean;
  nullable: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  example?: unknown;
  description?: string;
  // Set for object/array containers so a caller can tell a leaf from a branch.
  container?: 'object' | 'array' | 'map';
};

export type FieldMap = {
  tool: string;
  request: FieldNode[];
  response: FieldNode[];
  errors: FieldNode[];
  truncated: boolean;
  truncationReason?: 'depth' | 'count' | 'both';
};

// Bounds. A single Stripe operation can declare hundreds of fields across a
// deeply nested body; these keep one tool call from swamping an agent's context
// (OWASP LLM10) without silently pretending the rest does not exist.
const MAX_DEPTH = 8;
const MAX_FIELDS_PER_SECTION = 400;
const MAX_ENUM_VALUES = 30;
const MAX_DESCRIPTION = 200;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Third-party text: strip control characters, collapse whitespace, cap length.
// Mirrors advisor/types.ts asData(); duplicated rather than imported so this
// module stays free of any dependency on the advisor layer (lineage.ts and the
// persist path both consume it).
function clean(value: unknown, max = MAX_DESCRIPTION): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Schema) : null;
}

function typeOf(schema: Schema): { type: string; nullable: boolean } {
  const raw = schema.type;
  if (Array.isArray(raw)) {
    // sanitizeSchema rewrites OAS `nullable: true` into a ['string','null']
    // union, so a null member here IS the nullability signal.
    const members = raw.filter((t): t is string => typeof t === 'string');
    const nullable = members.includes('null');
    const rest = members.filter((t) => t !== 'null');
    return { type: rest.join('|') || 'null', nullable };
  }
  if (typeof raw === 'string') return { type: raw, nullable: false };
  if (schema.properties) return { type: 'object', nullable: false };
  if (schema.items) return { type: 'array', nullable: false };
  if (schema.enum) return { type: 'enum', nullable: false };
  return { type: 'unknown', nullable: false };
}

// oneOf/anyOf/allOf: merge member schemas rather than branching the output.
// A caller asking "what can I send" wants one answer, and emitting the same
// path once per branch would multiply the field count by the branch factor.
// allOf is a genuine intersection; oneOf/anyOf is a union we flatten and mark
// by keeping the first member's type, which is the honest approximation.
export function mergeCombinators(schema: Schema): Schema {
  // Provenance is carried per branch, not read off the parent. A schema can hold
  // allOf AND oneOf at once, and the guard below has to know which combinator
  // THIS branch came from.
  const branches: Array<{ schema: Schema; fromAllOf: boolean }> = [];
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const value = schema[key];
    if (Array.isArray(value)) {
      for (const member of value) {
        const sub = asSchema(member);
        if (sub) branches.push({ schema: sub, fromAllOf: key === 'allOf' });
      }
    }
  }
  if (!branches.length) return schema;

  const merged: Schema = { ...schema };
  delete merged.allOf;
  delete merged.oneOf;
  delete merged.anyOf;

  const properties: Schema = asSchema(merged.properties) ? { ...(merged.properties as Schema) } : {};
  const required = new Set(Array.isArray(merged.required) ? (merged.required as unknown[]).filter((r): r is string => typeof r === 'string') : []);

  for (const { schema: branch, fromAllOf } of branches) {
    const collapsed = mergeCombinators(branch);
    const branchProps = asSchema(collapsed.properties);
    if (branchProps) for (const [key, value] of Object.entries(branchProps)) properties[key] ??= value;
    // Only allOf members contribute requiredness — a oneOf member's `required`
    // applies to that branch alone, and hoisting it would report a field as
    // mandatory when an alternative branch does not need it.
    //
    // This used to test `Array.isArray(schema.allOf)` — the PARENT — while
    // iterating branches drawn from all three combinators. So a schema carrying
    // both allOf and oneOf hoisted the oneOf branches' required too, and marked
    // fields mandatory purely because an allOf happened to sit alongside them.
    if (Array.isArray(collapsed.required) && fromAllOf) {
      for (const r of collapsed.required) if (typeof r === 'string') required.add(r);
    }
    if (!merged.type && collapsed.type) merged.type = collapsed.type;
    if (!merged.items && collapsed.items) merged.items = collapsed.items;
    if (!merged.title && collapsed.title) merged.title = collapsed.title;
  }

  if (Object.keys(properties).length) merged.properties = properties;
  if (required.size) merged.required = [...required];
  return merged;
}

type WalkState = {
  out: FieldNode[];
  location: FieldLocation;
  hitDepth: boolean;
  hitCount: boolean;
};

function pushNode(state: WalkState, node: FieldNode): boolean {
  if (state.out.length >= MAX_FIELDS_PER_SECTION) {
    state.hitCount = true;
    return false;
  }
  state.out.push(node);
  return true;
}

function describe(schema: Schema, path: string, name: string, required: boolean, state: WalkState): FieldNode {
  const { type, nullable } = typeOf(schema);
  const container =
    type === 'array' || schema.items
      ? ('array' as const)
      : schema.properties
        ? ('object' as const)
        : asSchema(schema.additionalProperties)
          ? ('map' as const)
          : undefined;

  return {
    path,
    name,
    location: state.location,
    type,
    nullable,
    required,
    ...(typeof schema.format === 'string' ? { format: schema.format } : {}),
    ...(typeof schema.title === 'string' ? { title: clean(schema.title, 80) } : {}),
    ...(schema.readOnly === true ? { readOnly: true } : {}),
    ...(schema.writeOnly === true ? { writeOnly: true } : {}),
    ...(schema.deprecated === true ? { deprecated: true } : {}),
    ...(Array.isArray(schema.enum) ? { enum: schema.enum.slice(0, MAX_ENUM_VALUES) } : {}),
    ...(schema.const !== undefined ? { const: schema.const } : {}),
    ...(typeof schema.pattern === 'string' ? { pattern: schema.pattern } : {}),
    ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}),
    ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {}),
    ...(typeof schema.minLength === 'number' ? { minLength: schema.minLength } : {}),
    ...(typeof schema.maxLength === 'number' ? { maxLength: schema.maxLength } : {}),
    ...(schema.default !== undefined ? { default: schema.default } : {}),
    ...(schema.example !== undefined ? { example: schema.example } : {}),
    ...(clean(schema.description) ? { description: clean(schema.description) } : {}),
    ...(container ? { container } : {}),
  };
}

function walk(rawSchema: unknown, path: string, name: string, required: boolean, depth: number, state: WalkState): void {
  const base = asSchema(rawSchema);
  if (!base) return;
  const schema = mergeCombinators(base);

  if (depth > MAX_DEPTH) {
    state.hitDepth = true;
    return;
  }

  // The root of a section is not itself a field — only its children are.
  if (path) pushNode(state, describe(schema, path, name, required, state));

  const props = asSchema(schema.properties);
  if (props) {
    const requiredList = new Set(
      Array.isArray(schema.required) ? (schema.required as unknown[]).filter((r): r is string => typeof r === 'string') : [],
    );
    for (const [key, child] of Object.entries(props)) {
      walk(child, path ? `${path}.${key}` : key, key, requiredList.has(key), depth + 1, state);
    }
  }

  // Arrays: descend into the item schema, marking the hop with [] so the path
  // stays a faithful accessor. Array membership does not change requiredness.
  const items = asSchema(schema.items);
  if (items) walk(items, `${path}[]`, name, required, depth + 1, state);

  // Open maps (additionalProperties: <schema>) get a {*} wildcard segment —
  // the keys are caller-chosen, so there is no name to enumerate.
  const additional = asSchema(schema.additionalProperties);
  if (additional) walk(additional, `${path}{*}`, name, false, depth + 1, state);
}

// `rootName` is deliberately separate from `rootPath`: a query parameter's path
// is `query.status` but its NAME is `status`, and every cross-operation name
// comparison downstream (lineage.ts) keys on the name. Collapsing the two would
// silently break matching for every non-body parameter.
function section(
  rawSchema: unknown,
  location: FieldLocation,
  rootPath: string,
  rootName: string,
  rootRequired = false,
): WalkState {
  const state: WalkState = { out: [], location, hitDepth: false, hitCount: false };
  walk(rawSchema, rootPath, rootName, rootRequired, 0, state);
  return state;
}

// Request fields, with each top-level parameter's `x-docentapi-in` annotation
// carried down to its descendants. That annotation exists only on top-level
// properties (normalize.ts writes it there), so without this propagation every
// nested body field would be unattributed — which is precisely why the body has
// been an opaque blob until now.
function requestFields(action: Action): WalkState {
  const state: WalkState = { out: [], location: 'query', hitDepth: false, hitCount: false };
  const props = asSchema(action.paramsSchema.properties);
  if (!props) return state;

  const requiredList = new Set(
    Array.isArray(action.paramsSchema.required)
      ? (action.paramsSchema.required as unknown[]).filter((r): r is string => typeof r === 'string')
      : [],
  );

  for (const [name, child] of Object.entries(props)) {
    const declared = asSchema(child)?.['x-docentapi-in'];
    const location: FieldLocation =
      declared === 'path' || declared === 'query' || declared === 'header' || declared === 'body' ? declared : 'query';

    // The body's root path is just 'body', so its children read as `body.name`
    // rather than `body.body.name`. Other parameters are namespaced by location
    // so `query.id` and `path.id` stay distinguishable.
    const rootPath = location === 'body' ? 'body' : `${location}.${name}`;
    const sub = section(child, location, rootPath, name, requiredList.has(name));

    for (const node of sub.out) if (!pushNode(state, node)) break;
    state.hitDepth ||= sub.hitDepth;
    state.hitCount ||= sub.hitCount;
  }
  return state;
}

export function fieldMapFor(action: Action): FieldMap {
  const request = requestFields(action);
  const response = section(action.responseSchema, 'response', 'response', 'response');
  const errors = section(action.errorSchema, 'error', 'error', 'error');

  const hitDepth = request.hitDepth || response.hitDepth || errors.hitDepth;
  const hitCount = request.hitCount || response.hitCount || errors.hitCount;

  return {
    tool: action.name,
    request: request.out,
    response: response.out,
    errors: errors.out,
    truncated: hitDepth || hitCount,
    ...(hitDepth && hitCount
      ? { truncationReason: 'both' as const }
      : hitDepth
        ? { truncationReason: 'depth' as const }
        : hitCount
          ? { truncationReason: 'count' as const }
          : {}),
  };
}

// Classifies where a caller must get a value from. `producedByApi` is supplied
// by lineage.ts, which is the only part that needs cross-operation knowledge —
// everything else is decidable from the field alone.
export function originOf(field: FieldNode, producedByApi = false): FieldOrigin {
  if (field.readOnly) return 'server_generated';
  if (field.const !== undefined) return 'constant';
  if (producedByApi) return 'produced_by_api';
  if (field.enum?.length) return 'enum_constrained';
  return 'caller_supplied';
}

// The subset a client may actually send: leaves only (containers are structure,
// not values), minus anything the server generates. This IS the answer to
// "what data can we send it".
export function writableFields(map: FieldMap): FieldNode[] {
  return map.request.filter((f) => !f.readOnly && !f.container);
}

export type ApiFieldIndex = Map<string, FieldMap>;

export function buildFieldIndex(record: ImportRecord): ApiFieldIndex {
  const index: ApiFieldIndex = new Map();
  for (const action of record.actions) index.set(action.name, fieldMapFor(action));
  return index;
}

// Re-exported for lineage.ts, which needs the same notion of "a schema" without
// duplicating the guard.
export type { JSONSchema };
