// Whether an executed chain actually proved anything.
//
// This is the epistemically load-bearing module of Executed Lineage, and it
// exists as its own file for the same reason changes/observation.ts's
// reconcile() does: the rule for turning observations into a published claim
// deserves to be read on its own, not buried in the runner that produces them.
//
// THE CENTRAL RULE: a 2xx alone is correlation, not verification.
//
// Three ordinary API behaviours make a bare success meaningless. A soft-404 API
// returns 200 with `{"error":"not found"}`. A framework that ignores an
// unmatched path segment returns the collection. A handler may simply never
// read the parameter. Under a naive "we sent the id and got 200" rule, all
// three CONFIRM every edge pointed at them — including wrong ones — which would
// manufacture false confidence at scale and be worse than the honest
// "spec structure only" string this feature replaces.
//
// So every confirmation requires a NEGATIVE CONTROL: the same consumer, the
// same other parameters, and a format-valid but fabricated value in place of
// the real one. If the control also succeeds, the endpoint does not
// discriminate and the run proves nothing — `inconclusive`, never `observed`.
//
// The second rule is asymmetry. Confirmation needs one good run; REFUTATION
// needs agreement across runs, because a 404 is equally well explained by
// tenancy scoping, a deleted resource, or a rate limit. Making that asymmetry
// visible in the code is the point.

import type { ExtractReason } from './lineageExtract';

/** At least this many distinct candidate values before a run can conclude. */
export const MIN_CANDIDATES = 2;

/** Contradicted runs that must agree before an edge is published as refuted. */
export const MIN_CONTRADICTIONS = 2;

// Statuses that mean "this API looked at your identifier and rejected it".
// A 401/403 means it never got that far, and a 5xx means it broke — neither is
// evidence about the edge.
const DISCRIMINATING_REJECTIONS = new Set([400, 404, 422]);

export type ChainOutcome = 'confirmed' | 'contradicted' | 'inconclusive';

/** Closed vocabulary. Never a message — an error string is how a URL reaches a log. */
export type ChainReason =
  | 'ok'
  | 'control_also_succeeded'
  | 'control_not_attempted'
  | 'too_few_candidates'
  | 'producer_yielded_nothing'
  | 'mixed_results'
  | 'not_rejected_cleanly'
  | 'aborted';

export type ChainAttempts = {
  /** Distinct candidate values actually sent to the consumer. */
  candidatesTried: number;
  /** Consumer calls that returned 2xx. */
  successes: number;
  /** Consumer calls rejected with a discriminating status (400/404/422). */
  rejections: number;
  /** 5xx, auth failures, transport errors — evidence about nothing. */
  otherFailures: number;
  controlAttempted: boolean;
  /** Null when the control was never sent or never answered. */
  controlStatus: number | null;
  /** Set when the budget or deadline stopped the chain part-way. */
  aborted: boolean;
  extract: ExtractReason;
};

export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * One run's verdict on one edge.
 *
 * Ordered so the most informative refusal wins: a run that could not even get
 * candidates reports that, rather than reporting the downstream consequence.
 */
export function judgeRun(attempts: ChainAttempts): { outcome: ChainOutcome; reason: ChainReason } {
  const inconclusive = (reason: ChainReason) => ({ outcome: 'inconclusive' as const, reason });

  if (attempts.extract !== 'ok' || attempts.candidatesTried === 0) {
    return inconclusive('producer_yielded_nothing');
  }
  // A partial run cannot be trusted either way: the candidates that would have
  // changed the answer are exactly the ones that never went out.
  if (attempts.aborted) return inconclusive('aborted');
  if (attempts.candidatesTried < MIN_CANDIDATES) return inconclusive('too_few_candidates');

  if (attempts.successes > 0) {
    // The rule this module exists for.
    if (!attempts.controlAttempted || attempts.controlStatus === null) {
      return inconclusive('control_not_attempted');
    }
    if (isSuccess(attempts.controlStatus)) {
      // The endpoint answered a fabricated identifier just as happily. It is
      // not reading the parameter, or it soft-404s — either way the real
      // candidates proved nothing.
      return inconclusive('control_also_succeeded');
    }
    // Some worked and some did not. A real edge with a deleted record looks
    // like this, and so does a coincidence; neither earns a claim.
    if (attempts.successes < attempts.candidatesTried) return inconclusive('mixed_results');

    return { outcome: 'confirmed', reason: 'ok' };
  }

  // Nothing succeeded. Only a clean sweep of discriminating rejections is
  // evidence AGAINST the edge — a 500 or a 401 says nothing about it.
  if (attempts.rejections === attempts.candidatesTried && attempts.otherFailures === 0) {
    return { outcome: 'contradicted', reason: 'ok' };
  }
  return inconclusive('not_rejected_cleanly');
}

export function isDiscriminatingRejection(status: number): boolean {
  return DISCRIMINATING_REJECTIONS.has(status);
}

export type EdgeVerification = 'unattempted' | 'observed' | 'refuted' | 'inconclusive';

/** One stored run, newest first. */
export type ExecutionRow = {
  outcome: ChainOutcome;
  specVersionId: string;
  observedAt: Date;
  attempts: number;
  successes: number;
};

/**
 * The published verdict for an edge, across every run recorded for it.
 *
 * Deliberately two-level: the table stores one observation per run, and this
 * derives the claim. That is what stops a single flaky run from publishing
 * something alarming, the same discipline that keeps the canary from declaring
 * `behavior_ahead` off one observation.
 */
export function promoteVerdict(
  rows: ExecutionRow[],
  currentSpecVersionId: string,
): { verdict: EdgeVerification; attempts: number; successes: number; stale: boolean } {
  if (!rows.length) {
    return { verdict: 'unattempted', attempts: 0, successes: 0, stale: false };
  }

  const ordered = [...rows].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const [latest] = ordered;
  const stale = latest.specVersionId !== currentSpecVersionId;
  const base = { attempts: latest.attempts, successes: latest.successes, stale };

  // A confirmation describes the version it ran against. If the contract has
  // moved, the edge is not refuted — it is simply unverified again, and saying
  // "observed" would claim something about a version nobody tested.
  if (latest.outcome === 'confirmed') {
    return { verdict: stale ? 'inconclusive' : 'observed', ...base };
  }

  // Refutation needs agreement. A 404 is explained just as well by tenancy
  // scoping, a deleted record, or a rate limit as by a wrong edge, so one run
  // is never enough — and any confirmation in between resets the count.
  let contradictions = 0;
  for (const row of ordered) {
    if (row.outcome === 'confirmed') break;
    if (row.outcome === 'contradicted') contradictions++;
  }
  if (contradictions >= MIN_CONTRADICTIONS) {
    return { verdict: 'refuted', ...base };
  }

  return { verdict: 'inconclusive', ...base };
}
