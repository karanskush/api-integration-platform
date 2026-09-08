// What states does an entity on this API actually occupy?
//
// L2_ENGINE_SPEC.md §4 wants a full state-machine map: states, transitions, the
// call that triggers each, which are terminal. Discovering transitions means
// creating entities and driving them through their lifecycle — write probing,
// which needs the approved probe policy, sandbox separation and
// cleanup-as-correctness run states that do not exist yet.
//
// This is the read-only half that is honest on its own: the VOCABULARY, with no
// transition claimed. "A Subscription is one of active, past_due, canceled,
// trialing" is genuinely useful to an integrator — it is the list of cases their
// switch statement has to handle — and it is knowable from list responses alone.
//
// THE VALUE PROBLEM, AND THE GUARD. Unlike valueDomain.ts, the values here come
// out of RESPONSES, which is the direction this codebase refuses to store from.
// The guard that makes it admissible is CARDINALITY: a field whose distinct
// values are few and repeat across many records is a vocabulary, while a field
// with roughly as many distinct values as records is DATA — a name, an email, an
// id. Only the former is retained, and only from a short list of fields that
// name a state outright. A high-cardinality field is dropped whole, never
// sampled.

import type { EvidenceFactInput } from '../evidence';
import type { Action } from '../ir';
import { invokeAction } from '../mcpTools';
import type { ProbeContext } from './types';

const MAX_OPERATIONS = 2;
const STEP_TIMEOUT_MS = 8_000;
const PROBE_USER_AGENT = 'docentapi-probe/1.0 (+https://www.docentapi.xyz)';

// Fields that name a state outright. Deliberately short: `category` or `label`
// might hold a controlled vocabulary too, but they might equally hold free text,
// and the cost of being wrong here is retaining something we should not.
const STATE_FIELD_NAMES = /^(status|state|phase|stage|lifecycle|orderStatus|order_status)$/i;

// A state name is a short token. Anything with punctuation beyond a space,
// hyphen or underscore is prose or an identifier, not a state.
const STATE_VALUE_SHAPE = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/;

// An opaque identifier — a short prefix and a random-looking suffix, like
// `cus_A1b2C3`. Cardinality alone would accept one of these if every record
// happened to carry the SAME one, and while that cannot be per-record data it
// is still not a state name. Refused on shape rather than on frequency.
const OPAQUE_ID_SHAPE = /^[A-Za-z]{2,10}[_-][A-Za-z0-9]{6,}$/;

// Below this there is not enough repetition to tell a vocabulary from data.
const MIN_RECORDS = 4;
// A genuine state machine has few states. More than this and it is a taxonomy
// at best, data at worst.
const MAX_DISTINCT = 12;

type Json = unknown;

function isRecordObject(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The records in a list response, whether the body is a bare array or wraps one
// in the usual envelope key.
function recordsIn(body: Json): Array<Record<string, Json>> {
  if (Array.isArray(body)) return body.filter(isRecordObject);
  if (!isRecordObject(body)) return [];
  for (const key of ['data', 'items', 'results', 'records']) {
    const inner = body[key];
    if (Array.isArray(inner)) return inner.filter(isRecordObject);
  }
  return [];
}

/**
 * The state vocabulary a set of records exhibits, or null when the field looks
 * like data rather than a vocabulary.
 *
 * Exported for its own tests: this predicate is the entire safety argument, and
 * it deserves to be exercised directly rather than only through a probe run.
 */
export function vocabularyFor(
  records: Array<Record<string, Json>>,
  field: string,
): { values: string[]; sampleCount: number } | null {
  const seen: string[] = [];
  let sampled = 0;

  for (const record of records) {
    const raw = record[field];
    if (typeof raw !== 'string') continue;
    sampled++;
    // Abandon the whole field, not just this value: one prose or identifier
    // value means the field is not a state vocabulary at all, and keeping its
    // other values would publish a claim about a field we have misread.
    if (!STATE_VALUE_SHAPE.test(raw)) return null;
    if (OPAQUE_ID_SHAPE.test(raw)) return null;
    if (!seen.includes(raw)) seen.push(raw);
    // Bail as soon as it is clearly not a closed vocabulary, rather than
    // accumulating values we have already decided not to keep.
    if (seen.length > MAX_DISTINCT) return null;
  }

  if (sampled < MIN_RECORDS) return null;
  // THE GUARD: a vocabulary repeats. If nearly every record has its own value,
  // this is per-record data and must not be retained. Strictly fewer than half
  // distinct, so a field where each value appears only twice falls on the safe
  // side — two occurrences is not evidence of a closed vocabulary.
  if (seen.length * 2 >= sampled) return null;

  return { values: [...seen].sort(), sampleCount: sampled };
}

function stateFieldsIn(records: Array<Record<string, Json>>): string[] {
  const names = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (STATE_FIELD_NAMES.test(key)) names.add(key);
    }
  }
  return [...names];
}

// A list endpoint: a GET returning many records is the only place a vocabulary
// is visible, and a single-record GET can never satisfy MIN_RECORDS anyway.
function listCandidates(record: ProbeContext['record']): Action[] {
  return record.actions
    .filter((a) => a.method.toUpperCase() === 'GET' && a.safety === 'read')
    .filter((a) => !a.path.includes('{'))
    .filter((a) => {
      const required = a.paramsSchema.required;
      const names = Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : [];
      const example = a.examples[0]?.params ?? {};
      return names.every((n) => n in example);
    })
    .slice(0, MAX_OPERATIONS);
}

export async function runStateVocabulary(ctx: ProbeContext): Promise<EvidenceFactInput[]> {
  const invoke = ctx.invoke ?? invokeAction;
  const target = { baseUrls: ctx.record.baseUrls, authIn: ctx.record.authIn };
  const evidence: EvidenceFactInput[] = [];

  for (const action of listCandidates(ctx.record)) {
    let body: Json;
    try {
      const res = await invoke(action, action.examples[0]?.params ?? {}, target, ctx.upstreamKey, {
        timeoutMs: STEP_TIMEOUT_MS,
        userAgent: PROBE_USER_AGENT,
      });
      // Only a successful response describes the entity. An error body has its
      // own shape and its own `status` field, which would otherwise be recorded
      // as the entity's state vocabulary — a genuinely misleading claim.
      if (res.status < 200 || res.status >= 300) continue;
      body = JSON.parse(res.bodyText);
    } catch {
      continue;
    }

    const records = recordsIn(body);
    if (records.length < MIN_RECORDS) continue;

    for (const field of stateFieldsIn(records)) {
      const vocabulary = vocabularyFor(records, field);
      if (!vocabulary) continue;
      evidence.push({
        kind: 'probe.state_vocabulary',
        source: 'probe',
        actionId: action.id,
        payload: {
          actionId: action.id,
          field,
          values: vocabulary.values,
          sampleCount: vocabulary.sampleCount,
        },
      });
    }
  }

  return evidence;
}
