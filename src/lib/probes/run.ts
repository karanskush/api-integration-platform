import type { EvidenceFactInput } from '../evidence';
import type { ImportRecord } from '../ir';
import { invokeAction } from '../mcpTools';
import { runAuthClarity } from './authClarity';
import { runDocDrift } from './docDrift';
import { runErrorQuality } from './errorQuality';
import { runIdempotency } from './idempotency';
import { runValueDomain } from './valueDomain';
import { runStateVocabulary } from './stateVocabulary';
import { dedupeLifecycleEvidence } from './lifecycle';
import type { ProbeContext } from './types';

// Every upstream request any probe made, and how it went.
//
// This is what separates "we checked this API" from "we tried and nothing
// answered". Before it existed, a run where every single call failed still
// produced a score — authClarity computes its subscore before any I/O and
// idempotency makes no calls at all — so an unreachable API could publish a
// green badge. scoreWrite.ts refuses to write a `scores` row when `succeeded`
// is zero, which is the whole point of counting.
export type LiveCallLog = { attempted: number; succeeded: number; failed: number };

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

export async function runScoreEngine(
  record: ImportRecord,
  opts: { upstreamKey?: string; invoke?: typeof invokeAction } = {},
): Promise<ScoreEngineResult> {
  const liveCalls: LiveCallLog = { attempted: 0, succeeded: 0, failed: 0 };
  const ctx: ProbeContext = {
    record,
    upstreamKey: opts.upstreamKey,
    invoke: countingInvoke(opts.invoke ?? invokeAction, liveCalls),
  };

  const [authClarity, errorQuality, docDrift, idempotency] = await Promise.all([
    runAuthClarity(ctx),
    runErrorQuality(ctx),
    runDocDrift(ctx),
    runIdempotency(ctx),
  ]);

  // Runs after the scored probes and contributes NO subscore: whether an API
  // honours its own declared enum is a fact about the contract, not a quality
  // judgement, and folding it into a number would bury it. Rides the same
  // evidence array so it needs no new persistence path — SCORING_KINDS already
  // excludes anything that did not move the score, the way lifecycle signals
  // are handled.
  const valueDomain = await runValueDomain(ctx);
  const stateVocabulary = await runStateVocabulary(ctx);

  // Renormalized over only the subscores that actually ran — an API whose
  // spec never documents e.g. a responseSchema (so docDrift can't run) must
  // not be scored as if it silently failed that check.
  const ran = [authClarity, errorQuality, docDrift, idempotency].filter((o) => !o.insufficientData);
  const total = ran.length ? Math.round((ran.reduce((sum, o) => sum + o.subscore, 0) / (ran.length * 25)) * 100) : 0;

  // authClarity is a pure switch on the declared scheme and idempotency is a
  // regex over parameter names — neither can move because of a live response,
  // so both are static however many calls were made.
  const observedPoints =
    (errorQuality.insufficientData ? 0 : errorQuality.subscore) +
    (docDrift.insufficientData ? 0 : docDrift.subscore);
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
    evidence: dedupeLifecycleEvidence([
      ...authClarity.evidence,
      ...errorQuality.evidence,
      ...docDrift.evidence,
      ...idempotency.evidence,
      ...valueDomain,
      ...stateVocabulary,
    ]),
  };
}
