import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { Action } from './ir';

// One Ajv instance + compile cache shared by the playground proxy and the MCP
// tools/call path — the single source of argument validation.
const ajv = new Ajv({
  strict: false, // schemas carry x-docentapi-in annotations and OAS leftovers
  coerceTypes: true, // form inputs arrive as strings
  useDefaults: true,
  allErrors: true,
});
addFormats(ajv);

// Keyed on the SCHEMA, not on action.id.
//
// normalize.ts:80 derives action.id as sha1(`${method} ${path}`).slice(0, 8),
// which it documents as stable within an import — not unique across APIs. Two
// tenants who both expose `GET /v1/customers/{id}` therefore produce the
// identical id, and this cache is process-wide on a reused Fluid Compute
// instance, so the second API's arguments were validated against the first
// API's schema: a valid call rejected with a misleading error, or an invalid
// one forwarded upstream. Executed Lineage made that worse, because a chain
// consults validateParams before sending a real production identifier.
//
// The schema is the thing a compiled validator is actually a function of, so
// keying on it is correct by construction rather than by a uniqueness claim
// that was never true. Two actions sharing a schema legitimately share a
// validator. Key-ordering differences only cost a miss, never a wrong answer.
const cache = new Map<string, ValidateFunction>();

// The old key space was bounded by distinct method+path pairs; this one is
// bounded by distinct schemas, so it is evicted rather than left to grow.
const MAX_VALIDATORS = 500;

export function validateParams(action: Action, params: unknown): string | null {
  const key = JSON.stringify(action.paramsSchema);
  let fn = cache.get(key);
  if (!fn) {
    try {
      fn = ajv.compile(action.paramsSchema);
    } catch {
      return null; // schema too exotic to compile — let the upstream API judge
    }
    cache.set(key, fn);
    if (cache.size > MAX_VALIDATORS) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
  }
  if (fn(params)) return null;
  return (fn.errors ?? [])
    .slice(0, 5)
    .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`)
    .join('; ');
}
