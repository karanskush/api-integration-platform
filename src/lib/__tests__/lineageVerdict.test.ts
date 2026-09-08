// Whether an executed chain proved anything.
//
// The negative-control tests are the ones that matter. Without that rule a
// soft-404 API — one that answers 200 with `{"error":"not found"}` — would
// "confirm" every edge pointed at it, including wrong ones, and this feature
// would manufacture false confidence at scale. That is strictly worse than the
// honest "spec structure only" string it replaces.

import { describe, expect, it } from 'vitest';
import {
  judgeRun,
  promoteVerdict,
  MIN_CANDIDATES,
  type ChainAttempts,
  type ExecutionRow,
} from '../lineageVerdict';

function attempts(overrides: Partial<ChainAttempts> = {}): ChainAttempts {
  return {
    candidatesTried: 2,
    successes: 2,
    rejections: 0,
    otherFailures: 0,
    controlAttempted: true,
    controlStatus: 404,
    aborted: false,
    extract: 'ok',
    ...overrides,
  };
}

describe('a confirmation requires a negative control', () => {
  it('confirms when real ids work and a fabricated one does not', () => {
    expect(judgeRun(attempts())).toEqual({ outcome: 'confirmed', reason: 'ok' });
  });

  // THE test. A soft-404 API answers 200 to anything.
  it('refuses to confirm when the fabricated id also succeeds', () => {
    const result = judgeRun(attempts({ controlStatus: 200 }));
    expect(result.outcome).toBe('inconclusive');
    expect(result.reason).toBe('control_also_succeeded');
  });

  it('refuses to confirm when no control was run at all', () => {
    expect(judgeRun(attempts({ controlAttempted: false })).reason).toBe('control_not_attempted');
    expect(judgeRun(attempts({ controlStatus: null })).reason).toBe('control_not_attempted');
  });

  it('accepts any non-2xx control, including a 400', () => {
    expect(judgeRun(attempts({ controlStatus: 400 })).outcome).toBe('confirmed');
    expect(judgeRun(attempts({ controlStatus: 422 })).outcome).toBe('confirmed');
  });

  it('treats a 2xx control as non-discriminating whatever the code', () => {
    expect(judgeRun(attempts({ controlStatus: 204 })).outcome).toBe('inconclusive');
  });
});

describe('a single sample is never enough', () => {
  it(`needs at least ${MIN_CANDIDATES} distinct candidates`, () => {
    const result = judgeRun(attempts({ candidatesTried: 1, successes: 1 }));
    expect(result.outcome).toBe('inconclusive');
    expect(result.reason).toBe('too_few_candidates');
  });

  it('reports when the producer gave it nothing to try', () => {
    expect(judgeRun(attempts({ candidatesTried: 0, successes: 0 })).reason).toBe('producer_yielded_nothing');
    expect(judgeRun(attempts({ extract: 'empty_collection' })).reason).toBe('producer_yielded_nothing');
    expect(judgeRun(attempts({ extract: 'path_absent' })).reason).toBe('producer_yielded_nothing');
  });

  // The candidates that would have changed the answer are exactly the ones
  // that never went out.
  it('draws no conclusion from a run that was cut short', () => {
    expect(judgeRun(attempts({ aborted: true })).reason).toBe('aborted');
  });

  it('draws no conclusion when some ids worked and others did not', () => {
    const result = judgeRun(attempts({ candidatesTried: 3, successes: 2, rejections: 1 }));
    expect(result.outcome).toBe('inconclusive');
    expect(result.reason).toBe('mixed_results');
  });
});

describe('contradiction requires a clean sweep of discriminating rejections', () => {
  it('contradicts when every real id was rejected as not-found', () => {
    const result = judgeRun(attempts({ successes: 0, rejections: 2 }));
    expect(result).toEqual({ outcome: 'contradicted', reason: 'ok' });
  });

  // A 500 says the API broke, and a 401 says we never got that far. Neither is
  // evidence about whether the edge is real.
  it('does not contradict on server errors or auth failures', () => {
    const result = judgeRun(attempts({ successes: 0, rejections: 0, otherFailures: 2 }));
    expect(result.outcome).toBe('inconclusive');
    expect(result.reason).toBe('not_rejected_cleanly');
  });

  it('does not contradict on a mix of rejections and other failures', () => {
    expect(judgeRun(attempts({ successes: 0, rejections: 1, otherFailures: 1 })).outcome).toBe('inconclusive');
  });
});

describe('promoteVerdict', () => {
  const row = (overrides: Partial<ExecutionRow> = {}): ExecutionRow => ({
    outcome: 'confirmed',
    specVersionId: 'v1',
    observedAt: new Date('2026-09-01T00:00:00Z'),
    attempts: 2,
    successes: 2,
    ...overrides,
  });

  it('reports an edge nobody has tried', () => {
    expect(promoteVerdict([], 'v1').verdict).toBe('unattempted');
  });

  it('publishes a confirmed edge as observed', () => {
    expect(promoteVerdict([row()], 'v1').verdict).toBe('observed');
  });

  it('uses the most recent run, not the first', () => {
    const rows = [
      row({ observedAt: new Date('2026-08-01T00:00:00Z') }),
      row({ outcome: 'contradicted', observedAt: new Date('2026-09-01T00:00:00Z') }),
    ];
    expect(promoteVerdict(rows, 'v1').verdict).not.toBe('observed');
  });

  // A confirmation describes the version it ran against. Once the contract
  // moves, the edge is unverified again — not refuted, and not still observed.
  it('demotes a confirmation once the spec version moves on', () => {
    const result = promoteVerdict([row()], 'v2');
    expect(result.verdict).toBe('inconclusive');
    expect(result.stale).toBe(true);
  });

  it('never refutes on one contradicted run', () => {
    expect(promoteVerdict([row({ outcome: 'contradicted' })], 'v1').verdict).toBe('inconclusive');
  });

  it('refutes only once runs agree', () => {
    const rows = [
      row({ outcome: 'contradicted', observedAt: new Date('2026-09-02T00:00:00Z') }),
      row({ outcome: 'contradicted', observedAt: new Date('2026-09-01T00:00:00Z') }),
    ];
    expect(promoteVerdict(rows, 'v1').verdict).toBe('refuted');
  });

  it('lets an intervening confirmation reset the count', () => {
    const rows = [
      row({ outcome: 'contradicted', observedAt: new Date('2026-09-03T00:00:00Z') }),
      row({ outcome: 'confirmed', observedAt: new Date('2026-09-02T00:00:00Z') }),
      row({ outcome: 'contradicted', observedAt: new Date('2026-09-01T00:00:00Z') }),
    ];
    expect(promoteVerdict(rows, 'v1').verdict).toBe('inconclusive');
  });

  it('does not let inconclusive runs accumulate into a refutation', () => {
    const rows = [
      row({ outcome: 'inconclusive', observedAt: new Date('2026-09-02T00:00:00Z') }),
      row({ outcome: 'inconclusive', observedAt: new Date('2026-09-01T00:00:00Z') }),
    ];
    expect(promoteVerdict(rows, 'v1').verdict).toBe('inconclusive');
  });

  it('carries the latest run counts alongside the verdict', () => {
    const result = promoteVerdict([row({ attempts: 3, successes: 3 })], 'v1');
    expect(result.attempts).toBe(3);
    expect(result.successes).toBe(3);
  });
});

// Confirming is easier than refuting, on purpose, and the asymmetry should be
// demonstrable rather than merely commented.
describe('the confirm/refute asymmetry', () => {
  it('takes one run to confirm and two to refute', () => {
    const at = (iso: string, outcome: ExecutionRow['outcome']): ExecutionRow => ({
      outcome,
      specVersionId: 'v1',
      observedAt: new Date(iso),
      attempts: 2,
      successes: outcome === 'confirmed' ? 2 : 0,
    });

    expect(promoteVerdict([at('2026-09-01T00:00:00Z', 'confirmed')], 'v1').verdict).toBe('observed');
    expect(promoteVerdict([at('2026-09-01T00:00:00Z', 'contradicted')], 'v1').verdict).toBe('inconclusive');
  });
});
