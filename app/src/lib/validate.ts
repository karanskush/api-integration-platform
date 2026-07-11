import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { Action } from './ir';

// One Ajv instance + compile cache shared by the playground proxy and the MCP
// tools/call path — the single source of argument validation.
const ajv = new Ajv({
  strict: false, // schemas carry x-spotcheck-in annotations and OAS leftovers
  coerceTypes: true, // form inputs arrive as strings
  useDefaults: true,
  allErrors: true,
});
addFormats(ajv);

const cache = new Map<string, ValidateFunction>();

export function validateParams(action: Action, params: unknown): string | null {
  let fn = cache.get(action.id);
  if (!fn) {
    try {
      fn = ajv.compile(action.paramsSchema);
    } catch {
      return null; // schema too exotic to compile — let the upstream API judge
    }
    cache.set(action.id, fn);
  }
  if (fn(params)) return null;
  return (fn.errors ?? [])
    .slice(0, 5)
    .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`)
    .join('; ');
}
