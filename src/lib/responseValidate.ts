// Does a response body satisfy the schema the spec documents for it?
//
// A separate Ajv from validate.ts on purpose: that one coerces types and fills
// defaults because it validates what a person typed into a form. A RESPONSE is
// the provider's own output and must be judged as sent — a number that arrived
// as the string "42" is a conformance finding, not something to paper over.
//
// Findings are error PATHS and keywords only. Never the offending value: a
// response body is the provider's data, and this codebase does not write
// response values down.

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { JSONSchema } from './ir';

const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false, useDefaults: false });
addFormats(ajv);

const cache = new Map<string, ValidateFunction | null>();
const MAX_VALIDATORS = 500;
const MAX_ERRORS = 20;
const MAX_PATH_CHARS = 120;

export type ResponseValidation = {
  /** null when the schema could not be compiled — no judgement either way. */
  valid: boolean | null;
  errors: Array<{ path: string; keyword: string }>;
};

export function validateResponse(schema: JSONSchema, body: unknown): ResponseValidation {
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (fn === undefined) {
    try {
      fn = ajv.compile(schema);
    } catch {
      fn = null;
    }
    cache.set(key, fn);
    if (cache.size > MAX_VALIDATORS) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
  }
  if (!fn) return { valid: null, errors: [] };
  if (fn(body)) return { valid: true, errors: [] };
  const errors = (fn.errors ?? []).slice(0, MAX_ERRORS).map((e) => ({
    path: (e.instancePath || '(root)').slice(0, MAX_PATH_CHARS),
    keyword: e.keyword,
  }));
  return { valid: false, errors };
}
