// Per-action MCP call analytics (Pro+), read from the mcp_calls ledger.
//
// The ledger has been written fire-and-forget since Phase 1 and read by nothing
// — this is the read side. Beyond the dashboard, it is the input to the
// "agents fumble X on your API" claim-outreach angle in §11: a provider is far
// more likely to claim a page when you can show them which of their operations
// agents actually fail against.
//
// Everything here aggregates in Postgres rather than pulling rows into the
// lambda. A busy API generates a lot of calls, and shipping them all over the
// wire to count them in JS is how an analytics endpoint becomes the slowest
// route in the app.

import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from './db';
import { mcpCalls } from './db/schema';

export const WINDOWS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 } as const;
export type AnalyticsWindow = keyof typeof WINDOWS;

export function parseWindow(raw: string | null): AnalyticsWindow {
  return raw && raw in WINDOWS ? (raw as AnalyticsWindow) : '7d';
}

export function windowStart(window: AnalyticsWindow, now = Date.now()): Date {
  return new Date(now - WINDOWS[window] * 3600 * 1000);
}

// mcp_calls.status is text (it mirrors whatever the upstream returned), so
// bucketing happens in SQL with an explicit cast guard rather than assuming
// every historical row is numeric.
const statusInt = sql<number>`nullif(regexp_replace(${mcpCalls.status}, '[^0-9]', '', 'g'), '')::int`;

export type ToolStat = {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  creditsUsed: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
};

export type FailureClass = { statusClass: string; calls: number };

export type ApiAnalytics = {
  window: AnalyticsWindow;
  since: string;
  totals: { calls: number; errors: number; errorRate: number; creditsUsed: number };
  tools: ToolStat[];
  failureClasses: FailureClass[];
  busiestTool: string | null;
  worstTool: string | null;
};

const MAX_TOOLS = 100;

export async function apiAnalytics(db: Db, apiId: string, window: AnalyticsWindow = '7d'): Promise<ApiAnalytics> {
  const since = windowStart(window);
  const scope = and(eq(mcpCalls.apiId, apiId), gte(mcpCalls.createdAt, since));

  const rows = await db
    .select({
      tool: mcpCalls.tool,
      calls: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${statusInt} >= 400)::int`,
      creditsUsed: sql<number>`coalesce(sum(${mcpCalls.credits}), 0)::int`,
      // percentile_cont needs a numeric input and returns double; round for a
      // stable JSON shape.
      p50: sql<number | null>`round(percentile_cont(0.5) within group (order by ${mcpCalls.latencyMs}))::int`,
      p95: sql<number | null>`round(percentile_cont(0.95) within group (order by ${mcpCalls.latencyMs}))::int`,
    })
    .from(mcpCalls)
    .where(scope)
    .groupBy(mcpCalls.tool)
    .orderBy(sql`count(*) desc`)
    .limit(MAX_TOOLS);

  const classRows = await db
    .select({
      // 4xx/5xx rather than every distinct code: the class is what an owner
      // acts on, and it keeps the response bounded.
      statusClass: sql<string>`case
        when ${statusInt} is null then 'unknown'
        when ${statusInt} < 200 then '1xx'
        when ${statusInt} < 300 then '2xx'
        when ${statusInt} < 400 then '3xx'
        when ${statusInt} < 500 then '4xx'
        else '5xx'
      end`,
      calls: sql<number>`count(*)::int`,
    })
    .from(mcpCalls)
    .where(scope)
    .groupBy(sql`1`)
    .orderBy(sql`count(*) desc`);

  const tools: ToolStat[] = rows.map((r) => ({
    tool: r.tool,
    calls: r.calls,
    errors: r.errors,
    errorRate: r.calls ? Number((r.errors / r.calls).toFixed(4)) : 0,
    creditsUsed: r.creditsUsed,
    p50LatencyMs: r.p50 ?? null,
    p95LatencyMs: r.p95 ?? null,
  }));

  const calls = tools.reduce((sum, t) => sum + t.calls, 0);
  const errors = tools.reduce((sum, t) => sum + t.errors, 0);

  // "Worst" means most failures, not worst rate: a tool called twice and failing
  // twice is a 100% error rate and almost never the thing to fix first.
  const worst = tools.filter((t) => t.errors > 0).sort((a, b) => b.errors - a.errors)[0];

  return {
    window,
    since: since.toISOString(),
    totals: {
      calls,
      errors,
      errorRate: calls ? Number((errors / calls).toFixed(4)) : 0,
      creditsUsed: tools.reduce((sum, t) => sum + t.creditsUsed, 0),
    },
    tools,
    failureClasses: classRows,
    busiestTool: tools[0]?.tool ?? null,
    worstTool: worst?.tool ?? null,
  };
}

export type OrgUsage = { calls: number; creditsUsed: number; since: string };

// Org-wide rollup for the billing/usage view. Separate from apiAnalytics
// because it answers a different question (what am I being metered for) and
// needs no per-tool breakdown.
export async function orgUsage(db: Db, orgId: string, window: AnalyticsWindow = '30d'): Promise<OrgUsage> {
  const since = windowStart(window);
  const [row] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      creditsUsed: sql<number>`coalesce(sum(${mcpCalls.credits}), 0)::int`,
    })
    .from(mcpCalls)
    .where(and(eq(mcpCalls.orgId, orgId), gte(mcpCalls.createdAt, since)));

  return { calls: row?.calls ?? 0, creditsUsed: row?.creditsUsed ?? 0, since: since.toISOString() };
}
