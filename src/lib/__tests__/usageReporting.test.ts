import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import {
  collectDailyUsage,
  meterEventName,
  previousUtcDay,
  reportDailyUsage,
  usageEventIdentifier,
  usageReportingReady,
} from '../usageReporting';

let db: TestDb;

const ENV_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_METER_EVENT_NAME'] as const;
const originals = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<string, string | undefined>;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originals[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

let seq = 0;
async function seedOrg(opts: { customer?: string | null } = {}) {
  seq += 1;
  const [org] = await db
    .insert(schema.orgs)
    .values({
      name: `Usage Org ${seq}`,
      slug: `usage-org-${seq}`,
      plan: 'pro',
      stripeCustomerId: opts.customer === undefined ? `cus_usage_${seq}` : opts.customer,
    })
    .returning();
  const [api] = await db
    .insert(schema.apis)
    .values({ orgId: org.id, slug: `usage-api-${seq}`, name: `Usage API ${seq}` })
    .returning();
  return { orgId: org.id, apiId: api.id, customer: org.stripeCustomerId };
}

async function recordCall(ids: { orgId: string; apiId: string }, at: Date, credits = 1) {
  await db.insert(schema.mcpCalls).values({
    apiId: ids.apiId,
    orgId: ids.orgId,
    tool: 'get_thing',
    status: '200',
    latencyMs: 10,
    credits,
    createdAt: at,
  });
}

describe('previousUtcDay', () => {
  // Closed day, not the current one: reporting today would report a partial
  // total that is still changing.
  it('returns the closed UTC day before now', () => {
    const now = new Date('2026-07-26T13:45:12.000Z');
    const { start, end, day } = previousUtcDay(now);
    expect(start.toISOString()).toBe('2026-07-25T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-07-26T00:00:00.000Z');
    expect(day).toBe('2026-07-25');
  });

  it('handles a month boundary', () => {
    expect(previousUtcDay(new Date('2026-08-01T00:00:01.000Z')).day).toBe('2026-07-31');
  });

  it('handles a year boundary', () => {
    expect(previousUtcDay(new Date('2027-01-01T05:00:00.000Z')).day).toBe('2026-12-31');
  });

  it('uses UTC regardless of the local clock', () => {
    // Just after UTC midnight: the closed day is still the day before.
    expect(previousUtcDay(new Date('2026-07-26T00:00:30.000Z')).day).toBe('2026-07-25');
  });
});

describe('usageEventIdentifier', () => {
  // The dedupe key that makes a cron retry safe instead of double-billing.
  it('is deterministic per org and day', () => {
    expect(usageEventIdentifier('org-1', '2026-07-25')).toBe(usageEventIdentifier('org-1', '2026-07-25'));
  });

  it('differs across orgs and across days', () => {
    expect(usageEventIdentifier('org-1', '2026-07-25')).not.toBe(usageEventIdentifier('org-2', '2026-07-25'));
    expect(usageEventIdentifier('org-1', '2026-07-25')).not.toBe(usageEventIdentifier('org-1', '2026-07-26'));
  });
});

describe('readiness', () => {
  it('is not ready without Stripe configured', () => {
    process.env.STRIPE_METER_EVENT_NAME = 'mcp_credits';
    expect(usageReportingReady()).toBe(false);
  });

  it('is not ready without a meter event name', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    expect(meterEventName()).toBeNull();
    expect(usageReportingReady()).toBe(false);
  });

  it('treats a whitespace-only meter name as unset', () => {
    process.env.STRIPE_METER_EVENT_NAME = '   ';
    expect(meterEventName()).toBeNull();
  });

  it('is ready when both are present', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    process.env.STRIPE_METER_EVENT_NAME = 'mcp_credits';
    expect(usageReportingReady()).toBe(true);
  });
});

describe('collectDailyUsage', () => {
  const start = new Date('2026-06-01T00:00:00.000Z');
  const end = new Date('2026-06-02T00:00:00.000Z');

  it('sums credits and calls per org within the window', async () => {
    const ids = await seedOrg();
    await recordCall(ids, new Date('2026-06-01T05:00:00.000Z'), 2);
    await recordCall(ids, new Date('2026-06-01T18:00:00.000Z'), 3);

    const usage = await collectDailyUsage(db, start, end);
    const row = usage.find((u) => u.orgId === ids.orgId)!;
    expect(row).toMatchObject({ calls: 2, credits: 5, stripeCustomerId: ids.customer });
  });

  it('excludes calls before the window and on the following day', async () => {
    const ids = await seedOrg();
    await recordCall(ids, new Date('2026-05-31T23:59:59.000Z'));
    await recordCall(ids, new Date('2026-06-02T00:00:00.000Z'));

    expect((await collectDailyUsage(db, start, end)).find((u) => u.orgId === ids.orgId)).toBeUndefined();
  });

  it('includes a call exactly at the window start and excludes one at the end', async () => {
    const ids = await seedOrg();
    await recordCall(ids, start);
    const usage = await collectDailyUsage(db, start, end);
    expect(usage.find((u) => u.orgId === ids.orgId)?.calls).toBe(1);
  });

  // A free-plan org has no Stripe customer; there is nothing to meter against.
  it('skips orgs with no Stripe customer', async () => {
    const ids = await seedOrg({ customer: null });
    await recordCall(ids, new Date('2026-06-01T05:00:00.000Z'));
    expect((await collectDailyUsage(db, start, end)).find((u) => u.orgId === ids.orgId)).toBeUndefined();
  });

  it('keeps orgs separate', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await recordCall(a, new Date('2026-06-01T05:00:00.000Z'), 4);
    await recordCall(b, new Date('2026-06-01T06:00:00.000Z'), 7);

    const usage = await collectDailyUsage(db, start, end);
    expect(usage.find((u) => u.orgId === a.orgId)?.credits).toBe(4);
    expect(usage.find((u) => u.orgId === b.orgId)?.credits).toBe(7);
  });

  it('returns nothing for a window with no traffic', async () => {
    const usage = await collectDailyUsage(db, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-02T00:00:00.000Z'));
    expect(usage).toEqual([]);
  });
});

describe('reportDailyUsage', () => {
  it('skips with a reason when Stripe is not configured, without touching the ledger', async () => {
    const result = await reportDailyUsage(db);
    expect(result.skipped).toContain('Stripe is not configured');
    expect(result.orgs).toEqual([]);
    expect(result.totalCredits).toBe(0);
  });

  it('explains specifically that the meter event name is missing', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    const result = await reportDailyUsage(db);
    expect(result.skipped).toContain('STRIPE_METER_EVENT_NAME');
  });

  it('reports the closed day even when configured but idle', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    process.env.STRIPE_METER_EVENT_NAME = 'mcp_credits';

    // No traffic yesterday for any org with a customer -> nothing to send, and
    // crucially no Stripe client is constructed.
    const now = new Date('2020-06-02T01:00:00.000Z');
    const result = await reportDailyUsage(db, { now });
    expect(result.day).toBe('2020-06-01');
    expect(result.orgs).toEqual([]);
  });
});
