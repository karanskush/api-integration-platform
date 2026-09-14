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

// ---------------------------------------------------------------------------
// Two more decorators on the same seam. They compose with withBudget exactly
// the way countingInvoke does — each is (typeof invokeAction) → (typeof
// invokeAction) — so an orchestrator stacks them once and no probe has to
// remember they exist.

export class WriteFenceError extends Error {
  constructor() {
    super('fenced');
    this.name = 'WriteFenceError';
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type WriteFenceOptions = {
  environment?: 'production' | 'sandbox';
  /** Tool names a sandbox write runner has been authorised to mutate. */
  allow?: ReadonlySet<string>;
};

/**
 * Refuses any mutating request the caller was not explicitly authorised to
 * make. The read engine wraps every probe with an empty allow-set, so a probe
 * that classified an operation wrongly, or a future probe written carelessly,
 * cannot mutate anything — the fence is structural, not a convention. Writes
 * pass only on a sandbox environment AND for a tool the policy approved.
 */
export function withWriteFence(inner: typeof invokeAction, opts: WriteFenceOptions = {}): typeof invokeAction {
  return (async (...args: Parameters<typeof invokeAction>) => {
    const [action] = args;
    const method = action.method.toUpperCase();
    const allowed = READ_METHODS.has(method) || (opts.environment === 'sandbox' && opts.allow?.has(action.name) === true);
    if (!allowed) throw new WriteFenceError();
    return inner(...args);
  }) as typeof invokeAction;
}

/**
 * Keeps sequential calls at least `minIntervalMs` apart. Providers on tight
 * per-minute limits (Dub's free plan allows 60) see a run as a steady trickle
 * rather than a burst, and the run stays well clear of the 429 that would
 * abort it.
 */
export function withPacing(
  inner: typeof invokeAction,
  minIntervalMs: number,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): typeof invokeAction {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastStartedAt = -Infinity;
  return (async (...args: Parameters<typeof invokeAction>) => {
    const wait = lastStartedAt + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    lastStartedAt = now();
    return inner(...args);
  }) as typeof invokeAction;
}
