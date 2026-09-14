// Does this API actually accept the values its spec says it does?
//
// describe_fields answers "what can I send here" entirely out of the spec: an
// `enum` is reported because the document declares one, and a `required` flag
// is reported because the document sets one. Neither has ever been checked. A
// spec that lists a fourth enum member the API rejects, or marks a parameter
// required when the API happily accepts its absence, is exactly the kind of
// drift this product exists to catch — and it is invisible today.
//
// THE VALUE RULE. Everything sent here comes from the SPEC — a declared enum
// member, or the absence of a parameter. Nothing is read out of a response, and
// nothing a customer owns is involved, so unlike the chain runner these values
// are safe to store and report verbatim. That asymmetry is the whole reason
// this probe can say "the API rejected 'archived'" while the canary can only
// ever say "a field of type string was present".
//
// Read-only and bounded: GET operations only, a fabricated value is never
// invented, and the caps below keep a run to a handful of requests.

import type { EvidenceFactInput } from '../evidence';
import type { Action } from '../ir';
import { specOnlyFiller, type ParamFiller } from '../paramFill';
import { callProbe } from './context';
import { lifecycleEvidence } from './lifecycle';
import type { ProbeContext } from './types';

// Deliberately small. This is a spot check that catches an obviously-wrong
// declaration, not an exhaustive exploration of the input space — that is
// MASTER_TECHNICAL_PLAN §12.8's job and needs its own policy.
const MAX_OPERATIONS = 2;
const MAX_ENUM_VALUES = 3;

// A declared enum member is third-party text from the provider's document, and
// it ends up both in a database column and in an MCP tool response read by an
// LLM. An enum member longer than this is not a value anyone sends as a query
// parameter, so refusing it costs nothing and keeps a hostile spec from parking
// a payload in either place.
const MAX_ENUM_VALUE_CHARS = 120;
type ParamSchema = Record<string, unknown>;

function paramsOf(action: Action): Array<{ name: string; schema: ParamSchema }> {
  const props = (action.paramsSchema.properties ?? {}) as Record<string, ParamSchema>;
  return Object.entries(props).map(([name, schema]) => ({ name, schema }));
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

// A query parameter is the only place this can safely vary a value: changing a
// path segment addresses a different record, and a body implies a write.
function enumCandidates(action: Action): Array<{ name: string; values: string[] }> {
  const out: Array<{ name: string; values: string[] }> = [];
  for (const { name, schema } of paramsOf(action)) {
    if (schema['x-docentapi-in'] !== 'query') continue;
    const declared = Array.isArray(schema.enum)
      ? schema.enum
      : Array.isArray((schema.items as ParamSchema | undefined)?.enum)
        ? ((schema.items as ParamSchema).enum as unknown[])
        : null;
    if (!declared || declared.length < 2) continue;
    const values = declared
      .filter((v): v is string => typeof v === 'string')
      .filter((v) => v.length > 0 && v.length <= MAX_ENUM_VALUE_CHARS)
      .slice(0, MAX_ENUM_VALUES);
    if (values.length >= 2) out.push({ name, values });
  }
  return out;
}

// Every required param except the one under test must be fillable, or a
// rejection tells us about the missing OTHER parameter rather than about this
// one — which would be a false finding rather than a missing one. The shared
// filler decides what "fillable" means, exactly as it does for every probe.
function baseParamsFor(action: Action, exclude: string, fill: ParamFiller, runId?: string): Record<string, unknown> | null {
  const outcome = fill(action, { exclude, runId });
  return outcome.ok ? outcome.params : null;
}

export async function runValueDomain(ctx: ProbeContext): Promise<EvidenceFactInput[]> {
  const fill = ctx.fill ?? specOnlyFiller;
  const evidence: EvidenceFactInput[] = [];

  const candidates = ctx.record.actions
    .filter((a) => a.method.toUpperCase() === 'GET' && a.safety === 'read')
    .filter((a) => enumCandidates(a).length > 0)
    .slice(0, MAX_OPERATIONS);

  for (const action of candidates) {
    for (const { name, values } of enumCandidates(action)) {
      const base = baseParamsFor(action, name, fill, ctx.runId);
      if (base === null) continue;

      for (const value of values) {
        try {
          const res = await callProbe(ctx, action, { ...base, [name]: value });
          // Rate-limit and lifecycle headers ride along on every response; this
          // probe used to be one of three that dropped them.
          evidence.push(...lifecycleEvidence(action, res.headers));
          // A 5xx says the API broke, not that it rejected the value — the same
          // rule docDrift and the canary now apply. Recording it as a rejection
          // would tell an agent to stop sending a value that is perfectly good.
          if (res.status >= 500) continue;
          // Nor does a 401/403: the API rejected the caller before it looked at
          // the value. Recording that as "rejected 'sold'" would tell an agent
          // a perfectly good enum member is refused.
          if (res.status === 401 || res.status === 403) continue;
          evidence.push({
            kind: 'probe.value_domain',
            source: 'probe',
            actionId: action.id,
            payload: {
              actionId: action.id,
              // fieldMap addressing (`query.status`), so describe_fields can
              // join this onto a field without a translation step — the same
              // reason lineageExtract shares inferShape's grammar.
              field: `query.${name}`,
              // Safe to store: it came from the provider's own published spec,
              // not from a response.
              value,
              accepted: isSuccess(res.status),
              status: res.status,
            },
          });
        } catch {
          // Unreachable, blocked, or rejected client-side. No observation —
          // never a fabricated one, which is how a probe ends up reporting an
          // exchange that never happened.
          continue;
        }
      }
      // One parameter per operation is enough for a spot check, and keeps the
      // outbound cost predictable.
      break;
    }
  }

  return evidence;
}
