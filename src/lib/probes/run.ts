import type { EvidenceFactInput } from '../evidence';
import type { ImportRecord } from '../ir';
import { invokeAction } from '../mcpTools';
import { pooledFiller, specOnlyFiller } from '../paramFill';
import { runAuthClarity } from './authClarity';
import { runReadConformance } from './conformance';
import { withPacing, withWriteFence, type OutboundBudget } from './budget';
import { runDocDrift } from './docDrift';
import { runErrorQuality } from './errorQuality';
import { harvestIds } from './harvest';
import { runIdempotency } from './idempotency';
import { dedupeLifecycleEvidence } from './lifecycle';
import { runStateVocabulary } from './stateVocabulary';
import type { ProbeContext, ProbeEnvironment, ProbeOutcome } from './types';
import { runValueDomain } from './valueDomain';

// Every upstream request any probe made, and how it went.
//
// This is what separates "we checked this API" from "we tried and nothing
// answered". Before it existed, a run where every single call failed still
// produced a score — authClarity computes its subscore before any I/O and
// idempotency makes no calls at all — so an unreachable API could publish a
// green badge. scoreWrite.ts refuses to write a `scores` row when `succeeded`
// is zero, which is the whole point of counting.
export type LiveCallLog = { attempted: number; succeeded: number; failed: number };

export type StageName =
  | 'auth_clarity'
  | 'harvest'
  | 'doc_drift'
  | 'error_quality'
  | 'idempotency'
  | 'value_domain'
  | 'state_vocabulary'
  | 'conformance';

/**
 * What became of a stage. "Did not run" and "ran and found nothing" are
 * different statements, and every earlier probe that collapsed them turned out
 * to be hiding a defect — so the vocabulary is closed and every stage reports.
 *
 * `ran`                 — made its calls and produced a measurement or evidence
 * `insufficient_data`   — ran, but nothing it saw supports a claim
 * `no_candidates`       — nothing in this spec qualified, so no call was made
 * `skipped_over_budget` — the shared request budget was already spent
 * `aborted`             — stopped early on a 429 or a budget/deadline error
 * `failed`              — threw; nothing recorded
 */
export type StageOutcome = 'ran' | 'insufficient_data' | 'no_candidates' | 'skipped_over_budget' | 'aborted' | 'failed';

export type StageReport = { stage: StageName; requests: number; outcome: StageOutcome };

export type ScoreEngineOptions = {
  upstreamKey?: string;
  invoke?: typeof invokeAction;
  /** The run-level ceiling. Read here only to skip a stage that cannot start; enforced by wrapping `invoke`. */
  budget?: OutboundBudget;
  /** Which environment the key belongs to. Stamped on every fact. */
  environment?: ProbeEnvironment;
  baseUrlOverride?: string;
  runId?: string;
  /** Minimum gap between outbound calls. Off by default so unit tests stay fast; orchestrators pass 250. */
  paceMs?: number;
  /** Harvest real ids from list endpoints before probing (default true). */
  harvest?: boolean;
};

export type ScoreEngineResult = {
  total: number;
  subscores: {
    authClarity: number;
    errorQuality: number | null;
    docDrift: number | null;
    idempotency: number;
  };
  liveCalls: LiveCallLog;
  // How much of `total` was actually observed against the running API versus
  // derived from the spec alone. authClarity and idempotency are structural by
  // construction; errorQuality and docDrift require a live response. Published
  // so nobody has to take "verified" on trust — the gap analysis asked for
  // exactly this split rather than a third name for the same blend.
  points: { observed: number; static: number; max: number };
  evidence: EvidenceFactInput[];
  environment: ProbeEnvironment;
  stages: StageReport[];
};

// Wraps the DI seam every probe already calls through, so the accounting is in
// one place and no probe has to remember to report. A non-2xx counts as a
// failure here: it means the API answered, but not in a way any probe can
// build a measurement on.
function countingInvoke(inner: typeof invokeAction, log: LiveCallLog): typeof invokeAction {
  return (async (...args: Parameters<typeof invokeAction>) => {
    log.attempted++;
    try {
      const res = await inner(...args);
      if (res.status >= 200 && res.status < 300) log.succeeded++;
      else log.failed++;
      return res;
    } catch (err) {
      log.failed++;
      throw err;
    }
  }) as typeof invokeAction;
}

const STATIC_KINDS = new Set<EvidenceFactInput['kind']>(['probe.idempotency_signal']);

function stamp(evidence: EvidenceFactInput[], environment: ProbeEnvironment): EvidenceFactInput[] {
  return evidence.map((e) =>
    e.environment ? e : { ...e, environment: STATIC_KINDS.has(e.kind) ? 'static' : environment },
  );
}

const EMPTY: ProbeOutcome = { subscore: 0, evidence: [], insufficientData: true };

export async function runScoreEngine(record: ImportRecord, opts: ScoreEngineOptions = {}): Promise<ScoreEngineResult> {
  const environment = opts.environment ?? 'production';
  const liveCalls: LiveCallLog = { attempted: 0, succeeded: 0, failed: 0 };

  // Decorators, innermost first: pace the wire, refuse any write (the read
  // engine authorises none — a mis-classified operation cannot mutate), count.
  let invoke = opts.invoke ?? invokeAction;
  if (opts.paceMs && opts.paceMs > 0) invoke = withPacing(invoke, opts.paceMs);
  invoke = withWriteFence(invoke, { environment, allow: new Set() });
  invoke = countingInvoke(invoke, liveCalls);

  const ctx: ProbeContext = {
    record,
    upstreamKey: opts.upstreamKey,
    invoke,
    budget: opts.budget,
    environment,
    baseUrlOverride: opts.baseUrlOverride,
    runId: opts.runId,
    fill: specOnlyFiller,
  };

  const stages: StageReport[] = [];
  const evidence: EvidenceFactInput[] = [];

  // Sequential, never Promise.all: outbound pressure on the provider is the
  // sum of what every stage sends, and one 429 must stop the run rather than
  // race three other stages to it.
  const stage = async <T>(
    name: StageName,
    needsNetwork: boolean,
    body: () => Promise<{ value: T; outcome: StageOutcome; evidence?: EvidenceFactInput[] }>,
    fallback: T,
  ): Promise<T> => {
    if (needsNetwork && opts.budget && opts.budget.remaining() < 1) {
      stages.push({ stage: name, requests: 0, outcome: 'skipped_over_budget' });
      return fallback;
    }
    const before = liveCalls.attempted;
    try {
      const result = await body();
      if (result.evidence) evidence.push(...result.evidence);
      const requests = liveCalls.attempted - before;
      // An evidence-only stage cannot tell "nothing qualified" from "I asked and
      // nothing answered usefully" on its own; the request count can.
      const outcome = result.outcome === 'no_candidates' && requests > 0 ? 'insufficient_data' : result.outcome;
      stages.push({ stage: name, requests, outcome });
      return result.value;
    } catch {
      stages.push({ stage: name, requests: liveCalls.attempted - before, outcome: 'failed' });
      return fallback;
    }
  };

  const outcomeOf = (o: ProbeOutcome): StageOutcome => (o.insufficientData ? 'insufficient_data' : 'ran');

  const authClarity = await stage(
    'auth_clarity',
    true,
    async () => {
      const o = await runAuthClarity(ctx);
      return { value: o, outcome: 'ran', evidence: o.evidence };
    },
    { subscore: 0, evidence: [] } as ProbeOutcome,
  );

  // Real ids for the reads that need one. The pool lives in this closure and
  // is dropped in the `finally` below; probes reach it only through ctx.fill.
  // Held on an object rather than a `let`: the assignment happens inside a
  // closure, and TypeScript's narrowing would otherwise decide the variable is
  // still null at the `finally`.
  const pool: { clear: (() => void) | null } = { clear: null };
  try {
    if (opts.harvest ?? true) {
      await stage(
        'harvest',
        true,
        async () => {
          const harvested = await harvestIds(ctx);
          pool.clear = harvested.clear;
          if (harvested.producers.length) ctx.fill = pooledFiller(harvested.pool);
          const outcome: StageOutcome = harvested.aborted
            ? 'aborted'
            : harvested.producers.length === 0
              ? 'no_candidates'
              : harvested.producers.some((p) => p.reason === 'ok')
                ? 'ran'
                : 'insufficient_data';
          return { value: undefined, outcome, evidence: harvested.evidence };
        },
        undefined,
      );
    } else {
      stages.push({ stage: 'harvest', requests: 0, outcome: 'no_candidates' });
    }

    const docDrift = await stage(
      'doc_drift',
      true,
      async () => {
        const o = await runDocDrift(ctx);
        return { value: o, outcome: outcomeOf(o), evidence: o.evidence };
      },
      EMPTY,
    );
    const errorQuality = await stage(
      'error_quality',
      true,
      async () => {
        const o = await runErrorQuality(ctx);
        return { value: o, outcome: outcomeOf(o), evidence: o.evidence };
      },
      EMPTY,
    );
    const idempotency = await stage(
      'idempotency',
      false,
      async () => {
        const o = await runIdempotency(ctx);
        return { value: o, outcome: 'ran', evidence: o.evidence };
      },
      { subscore: 0, evidence: [] } as ProbeOutcome,
    );

    // Contribute NO subscore: whether an API honours its own declared enum, or
    // which states an entity occupies, is a fact about the contract, not a
    // quality judgement, and folding it into a number would bury it. They ride
    // the same evidence array so they need no new persistence path.
    await stage(
      'value_domain',
      true,
      async () => {
        const facts = await runValueDomain(ctx);
        return { value: undefined, outcome: facts.length ? 'ran' : 'no_candidates', evidence: facts };
      },
      undefined,
    );
    await stage(
      'state_vocabulary',
      true,
      async () => {
        const facts = await runStateVocabulary(ctx);
        return { value: undefined, outcome: facts.length ? 'ran' : 'no_candidates', evidence: facts };
      },
      undefined,
    );

    // Read-side conformance last, so the scored probes are never starved by it:
    // a fabricated id, one OPTIONS per path, and three pagination requests.
    await stage(
      'conformance',
      true,
      async () => {
        const report = await runReadConformance(ctx);
        const outcome: StageOutcome = report.substages.some((s) => s.outcome === 'aborted')
          ? 'aborted'
          : report.evidence.length
            ? 'ran'
            : 'no_candidates';
        return { value: undefined, outcome, evidence: report.evidence };
      },
      undefined,
    );

    // Renormalized over only the subscores that actually ran — an API whose
    // spec never documents e.g. a responseSchema (so docDrift can't run) must
    // not be scored as if it silently failed that check.
    const ran = [authClarity, errorQuality, docDrift, idempotency].filter((o) => !o.insufficientData);
    const total = ran.length ? Math.round((ran.reduce((sum, o) => sum + o.subscore, 0) / (ran.length * 25)) * 100) : 0;

    // authClarity is a pure switch on the declared scheme and idempotency is a
    // regex over parameter names — neither can move because of a live response,
    // so both are static however many calls were made.
    const observedPoints =
      (errorQuality.insufficientData ? 0 : errorQuality.subscore) + (docDrift.insufficientData ? 0 : docDrift.subscore);
    const staticPoints = authClarity.subscore + idempotency.subscore;

    return {
      total,
      subscores: {
        authClarity: authClarity.subscore,
        errorQuality: errorQuality.insufficientData ? null : errorQuality.subscore,
        docDrift: docDrift.insufficientData ? null : docDrift.subscore,
        idempotency: idempotency.subscore,
      },
      liveCalls,
      points: { observed: observedPoints, static: staticPoints, max: ran.length * 25 },
      // Several probes can hit the same operation and see the same lifecycle
      // header; the graph should carry one fact, not one per probe.
      evidence: stamp(dedupeLifecycleEvidence(evidence), environment),
      environment,
      stages,
    };
  } finally {
    pool.clear?.();
    ctx.fill = specOnlyFiller;
  }
}
