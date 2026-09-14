// Read-side conformance: what an API does with an id no record has, which
// methods it admits to, and whether its pagination behaves.
//
// The checks are the ones every serious conformance tool runs (Schemathesis'
// use_after_free / unsupported_method / not_a_server_error family, RESTler's
// producer-consumer controls), applied read-only and bounded by the run's
// shared budget. Every sub-stage reports what became of it, because "we did not
// look" and "we looked and it was fine" are different statements.
//
// SAFETY: OPTIONS and GET only. The method probe never sends an undeclared
// mutating verb to discover a 405 — an undocumented POST is precisely the
// request that must not be made — and the engine's write fence would refuse it
// anyway. Pagination sends a token only when it is a token: a next value that
// looks like a URL or contains a path separator is never sent (the rule the
// chain runner exists to enforce), and nothing read from a response is retained.

import type { EvidenceFactInput } from '../evidence';
import type { Action } from '../ir';
import { paginationFor } from '../pagination';
import { specOnlyFiller, type ParamFiller } from '../paramFill';
import { fabricateLike, isValueRef, makeRef, type ValueRef } from '../transient';
import { callProbe } from './context';
import { hasReadableMessage, matchesErrorSchema } from './errorQuality';
import { lifecycleEvidence } from './lifecycle';
import { recordsIn } from './stateVocabulary';
import type { ProbeContext } from './types';

export type ConformanceStage = 'not_found_identity' | 'method_support' | 'pagination';
export type ConformanceOutcome = 'ran' | 'no_candidates' | 'insufficient_data' | 'skipped_over_budget' | 'aborted';

export type ConformanceReport = {
  evidence: EvidenceFactInput[];
  requests: number;
  substages: Array<{ stage: ConformanceStage; outcome: ConformanceOutcome; requests: number }>;
};

export type ConformanceOptions = {
  /** Operations per sub-stage. */
  maxOperations?: number;
};

const DEFAULT_MAX_OPERATIONS = 2;
const PAGINATION_REQUESTS = 3;
const MAX_TOKEN_CHARS = 200;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

type Schema = Record<string, unknown>;

function propsOf(action: Action): Record<string, Schema> {
  return (action.paramsSchema.properties ?? {}) as Record<string, Schema>;
}

function pathParamOf(action: Action): string | null {
  const props = propsOf(action);
  return Object.keys(props).find((k) => props[k]?.['x-docentapi-in'] === 'path') ?? null;
}

function isGetRead(action: Action): boolean {
  return action.method.toUpperCase() === 'GET' && action.safety === 'read';
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

// A stable fingerprint of a page's first record, compared in memory and never
// written down. Equal fingerprints mean the same record came back.
function firstRecordFingerprint(body: unknown): string | null {
  const records = recordsIn(body);
  if (!records.length) return null;
  return JSON.stringify(records[0]);
}

// The next-page value at `response.x.y`, read raw so it can be judged BEFORE it
// is wrapped: a URL or anything with a path separator is not a token we send.
function readNextToken(body: unknown, fieldPath: string | undefined): { ref: ValueRef } | { skipped: 'no_next' | 'next_is_url' } {
  if (!fieldPath) return { skipped: 'no_next' };
  const segments = fieldPath.split('.').slice(1).map((s) => s.replace(/\[\]$/, ''));
  let current: unknown = body;
  for (const key of segments) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return { skipped: 'no_next' };
    current = (current as Record<string, unknown>)[key];
  }
  if (current === undefined || current === null || current === '') return { skipped: 'no_next' };
  if (typeof current === 'string') {
    if (URL_LIKE.test(current) || current.includes('/') || current.length > MAX_TOKEN_CHARS) return { skipped: 'next_is_url' };
  } else if (typeof current !== 'number') {
    return { skipped: 'no_next' };
  }
  const ref = makeRef(current);
  return ref ? { ref } : { skipped: 'no_next' };
}

function parseAllow(header: string | undefined): Set<string> | null {
  if (!header) return null;
  return new Set(
    header
      .split(',')
      .map((m) => m.trim().toUpperCase())
      .filter((m) => /^[A-Z]{3,7}$/.test(m)),
  );
}

export async function runReadConformance(ctx: ProbeContext, opts: ConformanceOptions = {}): Promise<ConformanceReport> {
  const fill: ParamFiller = ctx.fill ?? specOnlyFiller;
  const maxOperations = opts.maxOperations ?? DEFAULT_MAX_OPERATIONS;
  const evidence: EvidenceFactInput[] = [];
  const substages: ConformanceReport['substages'] = [];
  let requests = 0;
  let aborted = false;

  const remaining = () => ctx.budget?.remaining() ?? Infinity;

  const call = async (action: Action, params: Record<string, unknown>) => {
    requests++;
    const res = await callProbe(ctx, action, params);
    evidence.push(...lifecycleEvidence(action, res.headers));
    if (res.status === 429) aborted = true;
    return res;
  };

  const stage = async (name: ConformanceStage, needed: number, body: () => Promise<ConformanceOutcome>) => {
    if (aborted) {
      substages.push({ stage: name, outcome: 'aborted', requests: 0 });
      return;
    }
    if (remaining() < needed) {
      substages.push({ stage: name, outcome: 'skipped_over_budget', requests: 0 });
      return;
    }
    const before = requests;
    let outcome: ConformanceOutcome;
    try {
      outcome = await body();
    } catch (err) {
      outcome = err instanceof Error && err.name === 'BudgetExhaustedError' ? 'aborted' : 'insufficient_data';
    }
    if (aborted && outcome !== 'aborted') outcome = 'aborted';
    substages.push({ stage: name, outcome, requests: requests - before });
  };

  // 1. What a made-up identifier gets. The one negative control every
  //    confirmation in this codebase requires: a 2xx to a fabricated id means
  //    the positive read proved less than it looked.
  await stage('not_found_identity', 1, async () => {
    const candidates = ctx.record.actions
      .filter((a) => isGetRead(a) && pathParamOf(a) !== null)
      .map((action) => ({ action, filled: fill(action, { runId: ctx.runId }) }))
      .filter((c) => c.filled.ok)
      .slice(0, maxOperations);
    if (!candidates.length) return 'no_candidates';

    let recorded = 0;
    for (const { action, filled } of candidates) {
      if (aborted || remaining() < 1 || !filled.ok) break;
      const key = pathParamOf(action)!;
      const real = filled.params[key];
      const decoy = isValueRef(real) ? fabricateLike(real) : typeof real === 'string' || typeof real === 'number' ? fabricateLike(makeRef(real)!) : null;
      if (!decoy) continue;
      const controlBasis = isValueRef(real) ? 'fabricated_like_real' : 'derived_placeholder';
      let res;
      try {
        res = await call(action, { ...filled.params, [key]: decoy });
      } catch {
        continue;
      }
      if (isAuthFailure(res.status) || res.status === 429) continue;
      const identity =
        res.status === 404
          ? 'not_found_404'
          : res.status === 410
            ? 'gone_410'
            : res.status >= 500
              ? 'server_error'
              : res.status >= 400
                ? 'rejected_other_4xx'
                : 'soft_404_2xx';
      recorded++;
      evidence.push({
        kind: 'probe.not_found_identity',
        source: 'probe',
        actionId: action.id,
        payload: {
          actionId: action.id,
          status: res.status,
          identity,
          controlBasis,
          matchesErrorSchema: res.status >= 400 ? matchesErrorSchema(action, res.bodyText) : null,
          hasReadableMessage: res.status >= 400 ? hasReadableMessage(res.bodyText) : false,
        },
      });
    }
    return recorded ? 'ran' : 'insufficient_data';
  });

  // 2. Which methods the path admits to. One OPTIONS per path; the Allow
  //    header is compared with what the spec declares on that path.
  await stage('method_support', 1, async () => {
    const seenPaths = new Set<string>();
    const candidates: Array<{ action: Action; params: Record<string, unknown> }> = [];
    for (const action of ctx.record.actions) {
      if (candidates.length >= maxOperations) break;
      if (!isGetRead(action) || seenPaths.has(action.path)) continue;
      const filled = fill(action, { runId: ctx.runId });
      if (!filled.ok) continue;
      seenPaths.add(action.path);
      candidates.push({ action, params: filled.params });
    }
    if (!candidates.length) return 'no_candidates';

    let recorded = 0;
    for (const { action, params } of candidates) {
      if (aborted || remaining() < 1) break;
      const options: Action = { ...action, method: 'OPTIONS' };
      let res;
      try {
        res = await call(options, params);
      } catch {
        continue;
      }
      if (isAuthFailure(res.status) || res.status === 429) continue;
      const declared = new Set(ctx.record.actions.filter((a) => a.path === action.path).map((a) => a.method.toUpperCase()));
      const allow = parseAllow(res.headers?.allow);
      let agreement: 'agrees' | 'allow_superset' | 'allow_subset' | 'disagrees' | null = null;
      let undeclared: string[] = [];
      if (allow) {
        const allowOnly = [...allow].filter((m) => !declared.has(m) && m !== 'OPTIONS' && m !== 'HEAD');
        const declaredOnly = [...declared].filter((m) => !allow.has(m));
        undeclared = allowOnly.slice(0, 8);
        agreement = !allowOnly.length && !declaredOnly.length ? 'agrees' : allowOnly.length && !declaredOnly.length ? 'allow_superset' : !allowOnly.length ? 'allow_subset' : 'disagrees';
      }
      recorded++;
      evidence.push({
        kind: 'probe.method_support',
        source: 'probe',
        actionId: action.id,
        payload: {
          actionId: action.id,
          path: action.path.slice(0, 200),
          method: 'OPTIONS',
          status: res.status,
          allowHeaderPresent: allow !== null,
          allowDeclaredAgreement: agreement,
          undeclaredMethods: undeclared,
        },
      });
    }
    return recorded ? 'ran' : 'insufficient_data';
  });

  // 3. Whether pagination behaves: start, continue, and (for cursors) whether a
  //    cursor may be reused. Three requests on one list operation.
  await stage('pagination', PAGINATION_REQUESTS, async () => {
    const candidate = ctx.record.actions.find((a) => {
      if (!isGetRead(a) || a.path.includes('{')) return false;
      const p = paginationFor(a);
      return p.model !== 'none' && Boolean(p.cursorParam || p.pageParam || p.offsetParam);
    });
    if (!candidate) return 'no_candidates';
    const pagination = paginationFor(candidate);
    const model = pagination.model as 'cursor' | 'page' | 'offset';
    const start = fill(candidate, { pageSize: 1, runId: ctx.runId });
    if (!start.ok) return 'no_candidates';

    const record = (payload: Record<string, unknown>) =>
      evidence.push({ kind: 'probe.pagination_behavior', source: 'probe', actionId: candidate.id, payload: { actionId: candidate.id, model, ...payload } });

    let first;
    try {
      first = await call(candidate, start.params);
    } catch {
      return 'insufficient_data';
    }
    if (isAuthFailure(first.status) || first.status === 429) return 'insufficient_data';
    let firstBody: unknown = null;
    try {
      firstBody = JSON.parse(first.bodyText);
    } catch {
      firstBody = null;
    }
    const startReport = { status: first.status, items: firstBody === null ? 0 : recordsIn(firstBody).length };
    if (first.status < 200 || first.status >= 300 || firstBody === null) {
      record({ start: startReport, continue: null, cursorReuse: null, skipped: 'start_failed' });
      return 'ran';
    }

    // The continuation request, model by model.
    let nextParams: Record<string, unknown> | null = null;
    let token: ValueRef | null = null;
    if (model === 'cursor' && pagination.cursorParam) {
      const next = readNextToken(firstBody, pagination.nextField);
      if ('skipped' in next) {
        record({ start: startReport, continue: null, cursorReuse: null, skipped: next.skipped });
        return 'ran';
      }
      token = next.ref;
      nextParams = { ...start.params, [pagination.cursorParam]: token };
    } else if (model === 'page' && pagination.pageParam) {
      nextParams = { ...start.params, [pagination.pageParam]: 2 };
    } else if (model === 'offset' && pagination.offsetParam) {
      nextParams = { ...start.params, [pagination.offsetParam]: 1 };
    }
    if (!nextParams) {
      record({ start: startReport, continue: null, cursorReuse: null, skipped: 'no_next' });
      return 'ran';
    }

    const firstFp = firstRecordFingerprint(firstBody);
    let second;
    try {
      second = await call(candidate, nextParams);
    } catch {
      record({ start: startReport, continue: null, cursorReuse: null });
      return 'ran';
    }
    let secondFp: string | null = null;
    try {
      secondFp = second.status >= 200 && second.status < 300 ? firstRecordFingerprint(JSON.parse(second.bodyText)) : null;
    } catch {
      secondFp = null;
    }
    const advanced = firstFp && secondFp ? firstFp !== secondFp : null;

    let cursorReuse: { status: number; samePage: boolean | null } | null = null;
    if (model === 'cursor' && token && !aborted && remaining() >= 1) {
      try {
        const again = await call(candidate, nextParams);
        let againFp: string | null = null;
        try {
          againFp = again.status >= 200 && again.status < 300 ? firstRecordFingerprint(JSON.parse(again.bodyText)) : null;
        } catch {
          againFp = null;
        }
        cursorReuse = { status: again.status, samePage: secondFp && againFp ? secondFp === againFp : null };
      } catch {
        cursorReuse = null;
      }
    }

    record({ start: startReport, continue: { status: second.status, advanced }, cursorReuse });
    return 'ran';
  });

  return { evidence, requests, substages };
}
