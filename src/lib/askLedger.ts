// How one streamed ask turn becomes one mcp_calls row.
//
// Extracted as a pure function because the route has no test harness — Clerk,
// `after()` and the database would all need mocking to reach this logic through
// a request, so in practice it would never be tested at all. The mapping is the
// part that can be wrong in a way nobody notices, since a mis-billed row looks
// exactly like a correct one.
//
// Streaming moves this: the Response is handed to the runtime long before the
// model stops, so the row cannot be written from the request body's return path.
// The route registers `after()` once, synchronously, and awaits an outcome the
// streamText callbacks resolve.

import { createHmac } from 'node:crypto';
import { deriveKey } from './keys';
import type { AskOutcome } from './ask';

// A ledger weight, not a hard gate. Kept PER TURN rather than spread across a
// conversation: the dashboard reads sum(credits) over a window, so re-pricing
// what a turn costs would silently rewrite the meaning of existing history.
export function askCredits(): number {
  const raw = process.env.ASK_CREDITS_PER_TURN;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5;
}

export type AskLedgerBase = {
  apiId: string;
  orgId: string;
  startedAt: number;
  callerHash?: string | null;
};

export type AskLedgerRow = {
  apiId: string;
  orgId: string;
  tool: 'ask';
  status: string;
  latencyMs: number;
  credits: number;
  callerHash: string | null;
};

// The sentinel the route passes when the outcome promise never settled — a
// stream that hung, or a runtime that froze the invocation before onEnd fired.
export const ASK_OUTCOME_UNSETTLED = { status: 'unsettled' } as const;

export function askLedgerRow(
  outcome: AskOutcome | typeof ASK_OUTCOME_UNSETTLED,
  base: AskLedgerBase,
  now = Date.now(),
): AskLedgerRow {
  const row = {
    apiId: base.apiId,
    orgId: base.orgId,
    tool: 'ask' as const,
    latencyMs: Math.max(0, now - base.startedAt),
    callerHash: base.callerHash ?? null,
  };

  switch (outcome.status) {
    case 'ok':
      return { ...row, status: '200', credits: askCredits() };

    case 'error':
      // Unchanged from the single-shot route: a failed answer is not billed.
      return { ...row, status: '502', credits: 0 };

    case 'aborted':
      // Billed. The reader stopped reading, but the tokens up to that point were
      // really generated and really paid for. 499 is nginx's client-closed-request
      // convention; analytics.ts's statusInt regexp buckets it as 4xx, which is
      // where a caller-initiated stop belongs.
      return { ...row, status: '499', credits: askCredits() };

    default:
      // Billed, and deliberately a 5xx. Under-billing a hang would be the safer-
      // looking choice, but recording it as a success is worse: a systemic stall
      // would then be invisible in the failure-rate panel, which is the one place
      // it needs to show up.
      return { ...row, status: '504', credits: askCredits() };
  }
}

// Attribution for a column that exists (schema.ts) and has never been written.
// 'audit-actor' is already declared as "caller attribution in the audit log, not
// reversible" (keys.ts), which is exactly this use.
//
// This is the cheapest available mitigation for the known billing bug that
// mcp_calls.org_id is the PROVIDER's org while the route authorizes any signed-in
// viewer: it does not fix who is charged, but it does let an owner see that one
// caller accounted for the spend.
export function askCallerHash(userId: string): string {
  return createHmac('sha256', deriveKey('audit-actor')).update(userId).digest('hex').slice(0, 32);
}
