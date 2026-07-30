// Metered MCP-credit usage reported to Stripe (TECH_IMPLEMENTATION.md §2:
// "Stripe — subscriptions + metered MCP credits ... usage records from the
// credit counter").
//
// Aggregated daily rather than reported per call. One Stripe API call per MCP
// call would add third-party latency and a failure mode to the hot path, for a
// number that only needs to be right by the end of the billing period. This
// walks yesterday's mcp_calls instead and sends one meter event per org.
//
// Idempotency is the crux, because a cron retry must not double-bill. Every
// event carries a deterministic `identifier` derived from (org, day), and Stripe
// dedupes on it — so re-running the job for the same day is a no-op rather than
// a second charge. The day is closed (yesterday, UTC) precisely so the total
// cannot still be moving when it is reported.
//
// Both Redis-backed credit ceilings and this exist because they answer different
// questions: the ceiling is a real-time gate (may this call proceed), this is a
// billing record (what should the invoice say).

import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from './db';
import { mcpCalls, orgs } from './db/schema';
import { billingReady, getStripe } from './stripe';

// Unset means "don't report" — metered billing needs a meter configured in the
// Stripe dashboard first, and inventing an event name would silently drop
// events into a meter that doesn't exist.
export function meterEventName(): string | null {
  return process.env.STRIPE_METER_EVENT_NAME?.trim() || null;
}

export function usageReportingReady(): boolean {
  return billingReady() && Boolean(meterEventName());
}

// [start, end) of the UTC day before `now`. Closed on purpose: reporting today
// would report a partial, still-changing total.
export function previousUtcDay(now = new Date()): { start: Date; end: Date; day: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 86_400_000);
  return { start, end, day: start.toISOString().slice(0, 10) };
}

export type OrgDailyUsage = { orgId: string; stripeCustomerId: string; calls: number; credits: number };

export async function collectDailyUsage(db: Db, start: Date, end: Date): Promise<OrgDailyUsage[]> {
  return db
    .select({
      orgId: mcpCalls.orgId,
      stripeCustomerId: sql<string>`${orgs.stripeCustomerId}`,
      calls: sql<number>`count(*)::int`,
      credits: sql<number>`coalesce(sum(${mcpCalls.credits}), 0)::int`,
    })
    .from(mcpCalls)
    .innerJoin(orgs, eq(orgs.id, mcpCalls.orgId))
    .where(
      and(
        gte(mcpCalls.createdAt, start),
        lt(mcpCalls.createdAt, end),
        // No customer, nothing to meter against — a free-plan org has no
        // Stripe customer and is simply skipped.
        isNotNull(orgs.stripeCustomerId),
      ),
    )
    .groupBy(mcpCalls.orgId, orgs.stripeCustomerId)
    .having(sql`count(*) > 0`);
}

// Deterministic per (org, day): the dedupe key that makes a retry safe.
export function usageEventIdentifier(orgId: string, day: string): string {
  return `docentapi-usage-${orgId}-${day}`;
}

export type ReportOutcome = {
  orgId: string;
  credits: number;
  reported: boolean;
  error?: string;
};

export async function reportDailyUsage(
  db: Db,
  opts: { now?: Date } = {},
): Promise<{ day: string; skipped?: string; orgs: ReportOutcome[]; totalCredits: number }> {
  const { start, end, day } = previousUtcDay(opts.now);

  if (!usageReportingReady()) {
    return {
      day,
      skipped: !billingReady()
        ? 'Stripe is not configured'
        : 'STRIPE_METER_EVENT_NAME is not set — create a billing meter in Stripe and set its event name',
      orgs: [],
      totalCredits: 0,
    };
  }

  const usage = await collectDailyUsage(db, start, end);
  if (!usage.length) return { day, orgs: [], totalCredits: 0 };

  const stripe = getStripe();
  const eventName = meterEventName()!;
  const timestamp = Math.floor(start.getTime() / 1000);
  const outcomes: ReportOutcome[] = [];

  for (const row of usage) {
    try {
      await stripe.billing.meterEvents.create({
        event_name: eventName,
        identifier: usageEventIdentifier(row.orgId, day),
        timestamp,
        payload: {
          stripe_customer_id: row.stripeCustomerId,
          value: String(row.credits),
        },
      });
      outcomes.push({ orgId: row.orgId, credits: row.credits, reported: true });
    } catch (err) {
      // One org's failure must not abandon the rest of the batch: the identifier
      // makes a later retry of this same day safe, so partial success is
      // recoverable rather than corrupting.
      console.error('[usage] meter event failed', {
        orgId: row.orgId,
        day,
        reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
      });
      outcomes.push({
        orgId: row.orgId,
        credits: row.credits,
        reported: false,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  return {
    day,
    orgs: outcomes,
    totalCredits: outcomes.filter((o) => o.reported).reduce((sum, o) => sum + o.credits, 0),
  };
}
