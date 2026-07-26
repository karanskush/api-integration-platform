import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { apiAnalytics, orgUsage, parseWindow, windowStart, WINDOWS } from '../analytics';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

let seq = 0;
async function seed() {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `An Org ${seq}`, slug: `an-org-${seq}`, plan: 'pro' }).returning();
  const [api] = await db
    .insert(schema.apis)
    .values({ orgId: org.id, slug: `an-api-${seq}`, name: `An API ${seq}` })
    .returning();
  return { orgId: org.id, apiId: api.id };
}

type CallInput = { tool: string; status: string; latencyMs: number; credits?: number; ageHours?: number };

async function recordCalls(ids: { orgId: string; apiId: string }, calls: CallInput[]) {
  for (const call of calls) {
    await db.insert(schema.mcpCalls).values({
      apiId: ids.apiId,
      orgId: ids.orgId,
      tool: call.tool,
      status: call.status,
      latencyMs: call.latencyMs,
      credits: call.credits ?? 1,
      ...(call.ageHours ? { createdAt: new Date(Date.now() - call.ageHours * 3600 * 1000) } : {}),
    });
  }
}

describe('parseWindow', () => {
  it('defaults to 7d and rejects anything unrecognised', () => {
    expect(parseWindow(null)).toBe('7d');
    expect(parseWindow('nonsense')).toBe('7d');
    expect(parseWindow('1y')).toBe('7d');
  });

  it('accepts the supported windows', () => {
    for (const window of Object.keys(WINDOWS)) expect(parseWindow(window)).toBe(window);
  });
});

describe('windowStart', () => {
  it('subtracts the window from now', () => {
    const now = Date.UTC(2026, 6, 26, 12, 0, 0);
    expect(windowStart('24h', now).toISOString()).toBe(new Date(now - 86_400_000).toISOString());
    expect(windowStart('7d', now).toISOString()).toBe(new Date(now - 7 * 86_400_000).toISOString());
  });
});

describe('apiAnalytics', () => {
  it('returns an empty, well-formed shape when there is no traffic', async () => {
    const ids = await seed();
    const result = await apiAnalytics(db, ids.apiId);
    expect(result).toMatchObject({
      window: '7d',
      totals: { calls: 0, errors: 0, errorRate: 0, creditsUsed: 0 },
      tools: [],
      busiestTool: null,
      worstTool: null,
    });
  });

  it('aggregates calls, errors, and an error rate per tool', async () => {
    const ids = await seed();
    await recordCalls(ids, [
      { tool: 'get_pet', status: '200', latencyMs: 100 },
      { tool: 'get_pet', status: '200', latencyMs: 200 },
      { tool: 'get_pet', status: '404', latencyMs: 50 },
      { tool: 'create_pet', status: '500', latencyMs: 300 },
    ]);

    const result = await apiAnalytics(db, ids.apiId);
    const getPet = result.tools.find((t) => t.tool === 'get_pet')!;
    expect(getPet).toMatchObject({ calls: 3, errors: 1, errorRate: 0.3333 });
    expect(result.totals).toMatchObject({ calls: 4, errors: 2, errorRate: 0.5 });
  });

  it('computes latency percentiles', async () => {
    const ids = await seed();
    await recordCalls(
      ids,
      Array.from({ length: 100 }, (_, i) => ({ tool: 'get_pet', status: '200', latencyMs: i + 1 })),
    );
    const [tool] = (await apiAnalytics(db, ids.apiId)).tools;
    expect(tool.p50LatencyMs).toBeGreaterThanOrEqual(50);
    expect(tool.p50LatencyMs).toBeLessThanOrEqual(51);
    expect(tool.p95LatencyMs).toBeGreaterThanOrEqual(95);
  });

  it('sums credits per tool and overall', async () => {
    const ids = await seed();
    await recordCalls(ids, [
      { tool: 'get_pet', status: '200', latencyMs: 10, credits: 2 },
      { tool: 'get_pet', status: '200', latencyMs: 10, credits: 3 },
    ]);
    const result = await apiAnalytics(db, ids.apiId);
    expect(result.tools[0].creditsUsed).toBe(5);
    expect(result.totals.creditsUsed).toBe(5);
  });

  it('ranks tools by volume and reports the busiest', async () => {
    const ids = await seed();
    await recordCalls(ids, [
      { tool: 'quiet', status: '200', latencyMs: 10 },
      { tool: 'busy', status: '200', latencyMs: 10 },
      { tool: 'busy', status: '200', latencyMs: 10 },
      { tool: 'busy', status: '200', latencyMs: 10 },
    ]);
    const result = await apiAnalytics(db, ids.apiId);
    expect(result.tools[0].tool).toBe('busy');
    expect(result.busiestTool).toBe('busy');
  });

  // worstTool is deliberately most-failures, not worst-rate: a tool called
  // twice and failing twice is 100% and almost never the thing to fix first.
  it('reports the tool with the most failures as worst, not the worst rate', async () => {
    const ids = await seed();
    await recordCalls(ids, [
      { tool: 'rarely_used', status: '500', latencyMs: 10 },
      { tool: 'rarely_used', status: '500', latencyMs: 10 },
      ...Array.from({ length: 20 }, () => ({ tool: 'hot_path', status: '500', latencyMs: 10 })),
      ...Array.from({ length: 80 }, () => ({ tool: 'hot_path', status: '200', latencyMs: 10 })),
    ]);
    const result = await apiAnalytics(db, ids.apiId);
    expect(result.worstTool).toBe('hot_path');
  });

  it('leaves worstTool null when nothing failed', async () => {
    const ids = await seed();
    await recordCalls(ids, [{ tool: 'get_pet', status: '200', latencyMs: 10 }]);
    expect((await apiAnalytics(db, ids.apiId)).worstTool).toBeNull();
  });

  it('buckets failures by status class', async () => {
    const ids = await seed();
    await recordCalls(ids, [
      { tool: 'a', status: '200', latencyMs: 10 },
      { tool: 'a', status: '301', latencyMs: 10 },
      { tool: 'a', status: '404', latencyMs: 10 },
      { tool: 'a', status: '429', latencyMs: 10 },
      { tool: 'a', status: '503', latencyMs: 10 },
    ]);
    const classes = Object.fromEntries((await apiAnalytics(db, ids.apiId)).failureClasses.map((c) => [c.statusClass, c.calls]));
    expect(classes).toMatchObject({ '2xx': 1, '3xx': 1, '4xx': 2, '5xx': 1 });
  });

  // mcp_calls.status is text, so a non-numeric historical value must bucket
  // rather than break the whole query.
  it('buckets a non-numeric status as unknown instead of failing', async () => {
    const ids = await seed();
    await recordCalls(ids, [
      { tool: 'a', status: 'error', latencyMs: 10 },
      { tool: 'a', status: '', latencyMs: 10 },
    ]);
    const result = await apiAnalytics(db, ids.apiId);
    expect(result.failureClasses.find((c) => c.statusClass === 'unknown')?.calls).toBe(2);
    // Unknown is not counted as an error, since we cannot tell that it was one.
    expect(result.totals.errors).toBe(0);
  });

  it('excludes calls outside the window', async () => {
    const ids = await seed();
    await recordCalls(ids, [
      { tool: 'recent', status: '200', latencyMs: 10, ageHours: 1 },
      { tool: 'old', status: '200', latencyMs: 10, ageHours: 24 * 10 },
    ]);

    const week = await apiAnalytics(db, ids.apiId, '7d');
    expect(week.tools.map((t) => t.tool)).toEqual(['recent']);

    const month = await apiAnalytics(db, ids.apiId, '30d');
    expect(month.tools.map((t) => t.tool).sort()).toEqual(['old', 'recent']);
  });

  it('honours the 24h window boundary', async () => {
    const ids = await seed();
    await recordCalls(ids, [
      { tool: 'inside', status: '200', latencyMs: 10, ageHours: 2 },
      { tool: 'outside', status: '200', latencyMs: 10, ageHours: 30 },
    ]);
    expect((await apiAnalytics(db, ids.apiId, '24h')).tools.map((t) => t.tool)).toEqual(['inside']);
  });

  it('scopes to one API, never leaking another API’s traffic', async () => {
    const mine = await seed();
    const theirs = await seed();
    await recordCalls(mine, [{ tool: 'mine', status: '200', latencyMs: 10 }]);
    await recordCalls(theirs, [{ tool: 'theirs', status: '200', latencyMs: 10 }]);

    expect((await apiAnalytics(db, mine.apiId)).tools.map((t) => t.tool)).toEqual(['mine']);
  });

  it('reports the window start it used', async () => {
    const ids = await seed();
    const result = await apiAnalytics(db, ids.apiId, '24h');
    expect(new Date(result.since).getTime()).toBeLessThan(Date.now());
    expect(result.window).toBe('24h');
  });
});

describe('orgUsage', () => {
  it('rolls up calls and credits across every API in the org', async () => {
    const ids = await seed();
    const [second] = await db
      .insert(schema.apis)
      .values({ orgId: ids.orgId, slug: `an-api-${seq}-b`, name: 'Second API' })
      .returning();

    await recordCalls(ids, [{ tool: 'a', status: '200', latencyMs: 10, credits: 2 }]);
    await recordCalls({ orgId: ids.orgId, apiId: second.id }, [{ tool: 'b', status: '200', latencyMs: 10, credits: 3 }]);

    expect(await orgUsage(db, ids.orgId)).toMatchObject({ calls: 2, creditsUsed: 5 });
  });

  it('returns zeroes for an org with no traffic', async () => {
    const ids = await seed();
    expect(await orgUsage(db, ids.orgId)).toMatchObject({ calls: 0, creditsUsed: 0 });
  });

  it('does not count another org’s calls', async () => {
    const mine = await seed();
    const theirs = await seed();
    await recordCalls(theirs, [{ tool: 'x', status: '200', latencyMs: 10, credits: 9 }]);
    expect(await orgUsage(db, mine.orgId)).toMatchObject({ calls: 0, creditsUsed: 0 });
  });

  it('respects the window', async () => {
    const ids = await seed();
    await recordCalls(ids, [{ tool: 'old', status: '200', latencyMs: 10, ageHours: 24 * 40 }]);
    expect((await orgUsage(db, ids.orgId, '30d')).calls).toBe(0);
  });
});

describe('mcpCalls cleanup', () => {
  it('cascades away with its API, so a deleted page leaves no orphan rows', async () => {
    const ids = await seed();
    await recordCalls(ids, [{ tool: 'a', status: '200', latencyMs: 10 }]);
    await db.delete(schema.apis).where(eq(schema.apis.id, ids.apiId));
    const rows = await db.select().from(schema.mcpCalls).where(eq(schema.mcpCalls.apiId, ids.apiId));
    expect(rows).toHaveLength(0);
  });
});
