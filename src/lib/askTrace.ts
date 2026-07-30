// The contract between what an advisor tool returned and what the Ask UI is
// allowed to claim about it.
//
// This lives in lib/ rather than components/ for one reason: isProbeBacked() is
// the lime rule, and inside a component it would never get a test. Electric lime
// (--verified) is EARNED in this product — it means a live probe actually ran —
// and the whole design collapses if a tool merely FINISHING can paint something
// lime. That is the same laundering `.import-progress span[data-state='done']
// { color: var(--fg-dim) }` already refuses in CSS.
//
// Mirrors three/palette.ts's earned(): a small, grep-able, testable place where
// the honesty claim is enforced rather than remembered.

export const ADVISOR_TOOL_NAMES = [
  'docentapi_search_endpoints',
  'docentapi_get_endpoint_schema',
  'docentapi_describe_fields',
  'docentapi_trace_field',
  'docentapi_get_call_sequence',
  'docentapi_explain_error',
  'docentapi_get_score_explanation',
  'docentapi_generate_contract_test',
] as const;

export type AdvisorToolName = (typeof ADVISOR_TOOL_NAMES)[number];

export function isAdvisorToolName(name: string): name is AdvisorToolName {
  return (ADVISOR_TOOL_NAMES as readonly string[]).includes(name);
}

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * True only when this tool's output carries a field that could only exist
 * because a live probe ran. Never true merely because the call succeeded.
 *
 * Deliberately per-tool and explicit rather than a generic "does the JSON
 * contain the word observed" scan: a spec description containing "observed"
 * would otherwise earn lime, which is exactly the failure this guards.
 */
export function isProbeBacked(tool: AdvisorToolName, output: unknown): boolean {
  const o = obj(output);
  if (!o) return false;

  switch (tool) {
    // search.ts attaches observedDrift, and retry.source === 'observed', only
    // when probe evidence exists for that operation.
    case 'docentapi_get_endpoint_schema':
      if (obj(o.observedDrift)) return true;
      return str(obj(o.retry)?.source) === 'observed';

    // errors.ts sets evidenceBasis to 'observed' when a real error was recorded
    // against this API, and 'http_semantics_and_spec' otherwise.
    case 'docentapi_explain_error':
      return str(o.evidenceBasis) === 'observed';

    // sequence.ts attaches a `verified` sentence to a step only when an
    // unauthenticated request was actually seen being rejected.
    case 'docentapi_get_call_sequence':
      return arr(o.steps).some((step) => str(obj(step)?.verified) !== null);

    // score.ts returns an explicit boolean, and it is the one place where the
    // NUMBER itself may also be rendered lime.
    case 'docentapi_get_score_explanation':
      return o.verified === true;

    // The rest are spec-derived by construction. fields.ts states it outright:
    // "spec structure only — derived from declared schemas, not observed
    // traffic". generate_contract_test CATCHES drift; it has not observed any.
    case 'docentapi_search_endpoints':
    case 'docentapi_describe_fields':
    case 'docentapi_trace_field':
    case 'docentapi_generate_contract_test':
      return false;
  }
}

export type TraceTone = 'neutral' | 'drift';

export type TraceLabel = {
  /** Present-tense, shown while the call is in flight. */
  running: string;
  /** Past-tense, shown once the result is in. */
  done: string;
  /** Short secondary fact, e.g. "4 matches". Null when there is nothing useful. */
  count: string | null;
  /** `drift` renders --drift: a caller-supplied field, a truncation, a warning. */
  tone: TraceTone;
  /** The endpoint this check was about, for linking to #action-<name>. */
  tool: string | null;
};

// Strings are truncated and quoted typographically. Long enough to identify the
// argument, short enough that a row never wraps to three lines.
function quoted(value: unknown, max = 28): string | null {
  const s = str(value);
  if (!s) return null;
  return `“${s.length > max ? `${s.slice(0, max)}…` : s}”`;
}

const DIRECTION_LABEL: Record<string, string> = {
  request: 'request fields',
  response: 'response fields',
  error: 'error fields',
  all: 'every field',
};

/**
 * Turns one tool call into the line a reader sees.
 *
 * The governing rule for arguments: an argument appears only if it changes what
 * the answer MEANS, not how much of it was fetched. So `field` and `tool` show;
 * `limit` never does.
 */
export function describeToolCall(
  tool: AdvisorToolName,
  input: unknown,
  output: unknown,
): TraceLabel {
  const i = obj(input) ?? {};
  const o = obj(output);
  const target = str(i.tool);
  const base = { count: null as string | null, tone: 'neutral' as TraceTone, tool: target };

  // An advisor error is itself a fact about the API — often a more useful one
  // than a success — and search.ts/fields.ts already write them as legible
  // sentences. Never hidden.
  const failure = o ? str(o.error) : null;
  if (failure) {
    return {
      ...base,
      running: 'checking…',
      done: failure.length > 80 ? `${failure.slice(0, 80)}…` : failure,
      tone: 'drift',
    };
  }

  switch (tool) {
    case 'docentapi_search_endpoints': {
      const query = quoted(i.query);
      const safety = str(i.safety);
      const scope = safety ? `${safety} endpoints` : 'endpoints';
      const matched = num(o?.matched);
      if (!query) {
        return {
          ...base,
          running: 'listing every endpoint…',
          done: 'listed every endpoint',
          count: num(o?.totalActions) !== null ? `${num(o?.totalActions)} total` : null,
        };
      }
      return {
        ...base,
        running: `searching ${scope} for ${query}…`,
        done: `searched ${scope} for ${query}`,
        count: matched === 0 ? 'nothing matched' : matched !== null ? `${matched} matches` : null,
        tone: matched === 0 ? 'drift' : 'neutral',
      };
    }

    case 'docentapi_get_endpoint_schema': {
      const sendable = num(obj(o?.fields)?.totalSendable);
      return {
        ...base,
        running: `reading ${target ?? 'the'} schema…`,
        done: `read ${target ?? 'the'} schema`,
        count: sendable !== null ? `${sendable} sendable fields` : null,
      };
    }

    case 'docentapi_describe_fields': {
      const direction = DIRECTION_LABEL[str(i.direction) ?? 'all'] ?? 'every field';
      const filter = quoted(i.filter);
      const summary = obj(o?.summary);
      const returned = num(summary?.returned);
      const matched = num(summary?.matched);
      const truncated = o?.truncated === true;
      const suffix = filter ? ` matching ${filter}` : '';
      return {
        ...base,
        running: `listing ${target ?? 'the'} ${direction}…`,
        done: `listed ${target ?? 'the'} ${direction}${suffix}`,
        count:
          truncated
            ? 'truncated'
            : returned !== null && matched !== null
              ? `${returned} of ${matched}`
              : null,
        tone: truncated ? 'drift' : 'neutral',
      };
    }

    // The most important label in the set. The product's honesty claim is that a
    // field with no producer is REPORTED as caller-supplied rather than guessed
    // at — and this row says it before the prose does, so the reader watches the
    // system decline to invent rather than being told that it did.
    case 'docentapi_trace_field': {
      const field = str(i.field) ?? 'the field';
      const where = target ? ` in ${target}` : '';
      const results = arr(o?.results);
      const producers = results.reduce<number>((n, r) => n + arr(obj(r)?.producedBy).length, 0);
      const consumers = results.reduce<number>((n, r) => n + arr(obj(r)?.consumedBy).length, 0);
      const allCallerSupplied =
        results.length > 0 && results.every((r) => str(obj(r)?.origin) === 'caller_supplied');
      return {
        ...base,
        running: `tracing ${field}…`,
        done: `traced ${field}${where}`,
        count: allCallerSupplied
          ? 'caller-supplied'
          : results.length
            ? `${producers} producers, ${consumers} consumers`
            : null,
        tone: allCallerSupplied ? 'drift' : 'neutral',
      };
    }

    case 'docentapi_get_call_sequence': {
      const steps = num(o?.stepCount) ?? (arr(o?.steps).length || null);
      const unresolved = arr(o?.unresolvedParameters).length;
      return {
        ...base,
        running: `working out the call sequence for ${target ?? 'this'}…`,
        done: `traced the call sequence for ${target ?? 'this'}`,
        count: unresolved > 0 ? `${unresolved} unresolved` : steps !== null ? `${steps} steps` : null,
        tone: unresolved > 0 ? 'drift' : 'neutral',
      };
    }

    case 'docentapi_explain_error': {
      const status = num(i.status);
      const where = target ? ` on ${target}` : ' on this API';
      const retryable = o?.retryable;
      return {
        ...base,
        running: `looking up ${status ?? 'that error'}${where}…`,
        done: `explained ${status ?? 'that error'}${where}`,
        count:
          retryable === true ? 'retry with backoff' : retryable === false ? 'not retryable' : null,
      };
    }

    case 'docentapi_get_score_explanation': {
      const total = num(o?.total);
      const verified = o?.verified === true;
      return {
        ...base,
        running: 'reading the Agent-Ready Score…',
        done: 'read the Agent-Ready Score',
        count: total !== null ? `${total}/100 ${verified ? 'verified' : 'preview'}` : null,
      };
    }

    case 'docentapi_generate_contract_test': {
      const language = str(i.language) ?? 'typescript';
      const pretty = language === 'typescript' ? 'TypeScript' : language === 'python' ? 'Python' : 'bash';
      const asserts = arr(obj(o?.asserts)?.documentedFields).length;
      const warning = str(o?.warning);
      return {
        ...base,
        running: `generating a ${pretty} contract test for ${target ?? 'this'}…`,
        done: `generated a ${pretty} contract test for ${target ?? 'this'}`,
        count: warning ? 'real request — sandbox first' : asserts ? `asserts ${asserts} fields` : null,
        tone: warning ? 'drift' : 'neutral',
      };
    }
  }
}

/**
 * The endpoints an answer is about, deduplicated and in first-seen order —
 * the citation footer, and the set that becomes #action-<name> links.
 */
export function citationsFrom(
  calls: Array<{ tool: AdvisorToolName; input: unknown }>,
): string[] {
  const seen: string[] = [];
  for (const call of calls) {
    const target = str(obj(call.input)?.tool);
    if (target && !seen.includes(target)) seen.push(target);
  }
  return seen;
}
