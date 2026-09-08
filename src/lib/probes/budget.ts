// One outbound ceiling per verification run.
//
// Every cap in the probe engine is a per-module constant — SAMPLE_LIMIT in
// errorQuality and docDrift, DEFAULT_SAMPLES × MAX_OPERATIONS in the canary —
// and MAX_PROBED_ACTIONS in probes/types.ts was evidently meant to be a
// run-level budget and is referenced by nothing. That was survivable while a
// run made at most ~21 requests. Executed Lineage adds chains on top, and the
// total becomes something a third party would reasonably call abuse if it were
// unbounded.
//
// The mechanism is deliberately `withBudget(invoke, budget)`, returning
// something with invokeAction's exact signature, so the ceiling is enforced at
// the SAME dependency-injection seam every probe already calls through. No
// probe has to remember to check it, and one wiring point in reverifyOne covers
// the score engine, the canary and the chain runner from a single pool.
//
// Requests are counted, not bytes or time-per-request — and a wall-clock
// deadline sits beside the count, because a request budget alone does not bound
// a function with a 60-second limit.

import type { invokeAction } from '../mcpTools';

export type BudgetStop = 'ok' | 'budget_exhausted' | 'deadline_exceeded';

export type OutboundBudget = {
  /** Reserves one request. False once the budget or the deadline is spent. */
  spend(): boolean;
  remaining(): number;
  /** Why further calls are refused, or 'ok' while they are still allowed. */
  reason(): BudgetStop;
};

export class BudgetExhaustedError extends Error {
  readonly stop: BudgetStop;
  constructor(stop: BudgetStop) {
    // Contentless on purpose, like VaultError: an outbound error message is a
    // classic way a URL — and therefore an identifier — reaches a log.
    super(stop);
    this.name = 'BudgetExhaustedError';
    this.stop = stop;
  }
}

export function createBudget(opts: {
  maxRequests: number;
  deadlineMs: number;
  now?: () => number;
}): OutboundBudget {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let spent = 0;

  const stopReason = (): BudgetStop => {
    if (now() - startedAt >= opts.deadlineMs) return 'deadline_exceeded';
    if (spent >= opts.maxRequests) return 'budget_exhausted';
    return 'ok';
  };

  return {
    spend() {
      if (stopReason() !== 'ok') return false;
      spent++;
      return true;
    },
    remaining() {
      return Math.max(0, opts.maxRequests - spent);
    },
    reason: stopReason,
  };
}

/**
 * Wraps an invoke so every call draws from one budget.
 *
 * Throws rather than returning a synthetic response when the budget is spent:
 * a fabricated `{ status: 0 }` would be indistinguishable from a real answer to
 * every probe downstream, and the codebase has already been bitten once by a
 * fabricated status reaching users as "returned an unreadable error on a 0
 * response". A throw is what every probe already handles as "no response to
 * grade".
 */
export function withBudget(inner: typeof invokeAction, budget: OutboundBudget): typeof invokeAction {
  return (async (...args: Parameters<typeof invokeAction>) => {
    if (!budget.spend()) throw new BudgetExhaustedError(budget.reason());
    return inner(...args);
  }) as typeof invokeAction;
}
