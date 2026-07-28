// Naming and resource-shape helpers shared by the lineage graph and the call
// sequencer.
//
// These started life inside advisor/sequence.ts. They moved here because
// lineage.ts needs them and sequence.ts needs lineage.ts — leaving them in
// place would have made that a circular import. sequence.ts re-exports them, so
// its existing public surface and tests are unchanged.

// `userId` | `user_id` | `user-id` | `USER_ID` -> ['user', 'id']
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

// The comparison key for two field names. `customerId`, `customer_id` and
// `CUSTOMER-ID` all collapse to `customer_id`, which is what lets a camelCase
// API and a snake_case one be reasoned about identically.
export function normalizeFieldName(name: string): string {
  return tokenize(name).join('_');
}

// Crude English singularization. Deliberately conservative: nouns that merely
// end in s (status, analysis, address) must survive intact, or every resource
// name derived from them matches nothing.
export function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (lower.endsWith('ies')) return `${lower.slice(0, -3)}y`; // companies -> company
  if (lower.endsWith('ses') || lower.endsWith('xes') || lower.endsWith('zes')) return lower.slice(0, -2); // addresses -> address
  if (/(?:ss|us|is)$/.test(lower)) return lower;
  if (lower.endsWith('s')) return lower.slice(0, -1);
  return lower;
}

// `/v1/pets/{petId}/toys/{toyId}` + `toyId` -> `/v1/pets/{petId}/toys`
// i.e. the collection the identifier addresses an item within.
export function collectionPathFor(path: string, param: string): string | null {
  const segments = path.split('/');
  const index = segments.findIndex((s) => s === `{${param}}`);
  if (index <= 0) return null;
  return segments.slice(0, index).join('/') || '/';
}

// Last static segment of a collection path, singularized: the resource an
// identifier under it refers to. `/v1/pets` -> `pet`.
export function resourceOf(collectionPath: string): string | null {
  const statics = collectionPath.split('/').filter((s) => s && !s.startsWith('{'));
  const last = statics[statics.length - 1];
  return last ? singularize(last) : null;
}

// Segments that WRAP a payload rather than name an entity. Stripe's
// `response.data[].id` is a Customer id, not a "data" id; a GitHub search's
// `response.items[].id` is a repository id. Treating these as entities would be
// strictly worse than the operation-path fallback callers hand back to.
const ENVELOPE_SEGMENTS = new Set([
  'data', 'items', 'item', 'results', 'result', 'records', 'record', 'list',
  'values', 'rows', 'entries', 'elements', 'nodes', 'edges', 'objects',
  'content', 'payload',
]);

// fieldMap.ts's own section roots (see fieldMapFor/requestFields): not entities.
const SECTION_ROOTS = new Set(['response', 'request', 'body', 'path', 'query', 'header', 'error']);

// The entity a FIELD PATH's own prefix names — the thing that OWNS the leaf.
//
//   response.category.id -> 'category'
//   response.tags[].id   -> 'tag'      (singularized)
//   response.data[].id   -> null       (envelope; caller falls back)
//   response.id | response[].id | path.petId -> null  (no owner but the root)
//
// This exists because lineage.ts previously derived a producer field's entity
// from its OPERATION path, which made `add_pet.response.id`,
// `add_pet.response.category.id` and `add_pet.response.tags[].id` all "pet" and
// therefore interchangeable sources for a `petId`. A Category id is not a Pet
// id, and the field's own path is the only place that says so — Petstore
// declares no schema `title`, and dereferencing inlines the $ref, so the
// component name is gone by the time we see it.
//
// Walks outward from the leaf, so `response.order.customer.id` is a customer
// id, not an order id.
export function entityFromFieldPath(path: string): string | null {
  const segments = path.split('.');
  segments.pop(); // the leaf is the value; we want what contains it
  for (let i = segments.length - 1; i >= 0; i--) {
    // fieldMap.ts appends the collection marker to the SAME segment, so the
    // segment is literally `tags[]`, not `tags` followed by `[]`.
    const bare = segments[i].replace(/\[\]$/, '').replace(/\{\*\}$/, '');
    if (!bare) continue;
    const lower = bare.toLowerCase();
    if (SECTION_ROOTS.has(lower) || ENVELOPE_SEGMENTS.has(lower)) continue;
    return singularize(bare);
  }
  return null;
}

// Version prefixes and RPC verb segments are not resources; treating them as
// such would make every operation on a `/v1/...` API look related.
const NON_RESOURCE_SEGMENT = /^(v\d+|api|rest|graphql|json|rpc|latest|current)$/i;

// Every resource noun a path mentions, most specific last. Used for affinity
// scoring, where any overlap counts rather than only the final segment.
export function pathResources(path: string): string[] {
  const out: string[] = [];
  for (const raw of path.split('/')) {
    if (!raw || raw.startsWith('{')) continue;
    // Slack-style RPC paths (`chat.postMessage`, `conversations.list`) carry
    // their resource in a dotted segment rather than a path segment.
    for (const piece of raw.split('.')) {
      if (!piece || NON_RESOURCE_SEGMENT.test(piece)) continue;
      const singular = singularize(piece);
      if (singular && !out.includes(singular)) out.push(singular);
    }
  }
  return out;
}

const ID_TOKENS = new Set(['id', 'ids', 'key', 'uuid', 'guid', 'slug', 'code', 'ref', 'reference', 'number', 'no', 'token']);

// Whether a field name denotes an identifier.
//
// This replaces a regex — /(^|[_-])(id|ids|...)$/i — that required the id token
// to be preceded by a start-of-string or a separator, and therefore never
// matched camelCase at all: `customer_id` was recognised, `customerId` was not.
// Tokenizing first makes both work, which is the difference between tracing a
// camelCase API's identifiers and silently ignoring all of them.
export function isIdLike(name: string): boolean {
  const tokens = tokenize(name);
  const last = tokens[tokens.length - 1];
  return last !== undefined && ID_TOKENS.has(last);
}

// `petId` -> `pet`, `customer_id` -> `customer`, `id` -> null.
// The resource a foreign-key-shaped field name points at.
export function resourceFromFieldName(name: string): string | null {
  const tokens = tokenize(name);
  if (tokens.length < 2) return null;
  const last = tokens[tokens.length - 1];
  if (!ID_TOKENS.has(last)) return null;
  return singularize(tokens.slice(0, -1).join('_'));
}

// Field names too common to identify anything on their own. An edge asserted
// purely because both sides call something `id` is how an agent ends up
// deleting the wrong resource, so these require a corroborating signal.
const GENERIC_FIELD_NAMES = new Set([
  'id', 'ids', 'name', 'type', 'kind', 'status', 'state', 'url', 'uri', 'href', 'link',
  'key', 'value', 'data', 'code', 'message', 'description', 'title', 'label', 'text',
  'content', 'body', 'result', 'results', 'item', 'items', 'object', 'error', 'errors',
  'count', 'total', 'size', 'length', 'index', 'position', 'order', 'sort',
  'created', 'updated', 'deleted', 'timestamp', 'date', 'time', 'version',
  'active', 'enabled', 'disabled', 'visible', 'hidden', 'deprecated', 'default',
  'page', 'limit', 'offset', 'cursor', 'next', 'previous', 'first', 'last',
  'metadata', 'meta', 'attributes', 'properties', 'options', 'config', 'settings',
]);

export function isGenericFieldName(normalized: string): boolean {
  return GENERIC_FIELD_NAMES.has(normalized);
}
