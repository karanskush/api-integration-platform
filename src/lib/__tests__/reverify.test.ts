import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import type { NeonDb } from '../db';
import type { Action, ImportRecord } from '../ir';
import { buildPersistStatements } from '../persist';
import { batchSize, findCandidates, reverifyOne, scheduledPlans, verifyIntervalHours } from '../reverify';
import type { ScoreEngineResult } from '../probes/run';

let db: TestDb;
let neonDb: NeonDb;

const ENV_KEY = 'DOCENTAPI_MASTER_KEY';
const originalKey = process.env[ENV_KEY];
const originalInterval = process.env.SCHEDULED_VERIFY_INTERVAL_HOURS;
const originalBatch = process.env.SCHEDULED_VERIFY_BATCH;

beforeAll(async () => {
  db = await createTestDb();
  // applyScoreRun/reimportApi call .batch(), which only neon-http implements;
  // the statements are plain thenables, so a sequential shim exercises them
  // end-to-end against pglite (same approach as claims/persist tests).
  (db as unknown as { batch: (items: Promise<unknown>[]) => Promise<unknown[]> }).batch = async (items) => {
    const out: unknown[] = [];
    for (const item of items) out.push(await item);
    return out;
  };
  neonDb = db as unknown as NeonDb;
}, 30_000);

beforeEach(() => {
  process.env[ENV_KEY] = Buffer.alloc(32, 31).toString('base64');
});

afterEach(() => {
  for (const [key, value] of [
    [ENV_KEY, originalKey],
    ['SCHEDULED_VERIFY_INTERVAL_HOURS', originalInterval],
    ['SCHEDULED_VERIFY_BATCH', originalBatch],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    name: 'get_thing',
    description: 'Get a thing',
    method: 'GET',
    path: '/things',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: 'read',
    examples: [],
    ...overrides,
  };
}

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  const actions = overrides.actions ?? [action()];
  return {
    id: 'rv',
    name: 'Reverify API',
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'bearer',
    actions,
    counts: { total: actions.length, read: actions.length, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

const SCORE: ScoreEngineResult = {
  total: 88,
  subscores: { authClarity: 25, errorQuality: 22, docDrift: null, idempotency: 20 },
  evidence: [{ kind: 'probe.auth_reject', source: 'probe', payload: { statusObserved: 401, expectedAuth: 'bearer' } }],
};

let seq = 0;
async function seedApi(opts: { plan?: string; claimStatus?: string; sourceUrl?: string; verifiedAt?: Date } = {}) {
  seq += 1;
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: `RV Org ${seq}`, slug: `rv-org-${seq}`, plan: opts.plan ?? 'business' })
    .returning();

  const rec = record({ sourceUrl: opts.sourceUrl });
  const rawText = `{"v":${seq}}`;
  const built = await buildPersistStatements(db, { orgId: org.id, record: rec, rawText });
  for (const statement of built.statements) await statement;

  await db
    .update(schema.apis)
    .set({ claimStatus: opts.claimStatus ?? 'claimed' })
    .where(eq(schema.apis.id, built.apiId));

  if (opts.sourceUrl) {
    await db
      .update(schema.specVersions)
      .set({ sourceUrl: opts.sourceUrl })
      .where(eq(schema.specVersions.id, built.specVersionId));
  }

  if (opts.verifiedAt) {
    await db.insert(schema.scores).values({
      apiId: built.apiId,
      specVersionId: built.specVersionId,
      total: 50,
      authClarity: 12,
      errorQuality: 12,
      docDrift: 12,
      idempotency: 14,
      explanation: [],
      verifiedAt: opts.verifiedAt,
    });
  }

  return { orgId: org.id, apiId: built.apiId, slug: built.slug, specVersionId: built.specVersionId, rawText };
}

function candidateFor(seeded: Awaited<ReturnType<typeof seedApi>>, overrides = {}) {
  return {
    apiId: seeded.apiId,
    slug: seeded.slug,
    orgId: seeded.orgId,
    plan: 'business',
    specVersionId: seeded.specVersionId,
    sourceUrl: null,
    lastVerifiedAt: null,
    ...overrides,
  };
}

describe('configuration', () => {
  it('defaults to a weekly cadence and a small batch', () => {
    delete process.env.SCHEDULED_VERIFY_INTERVAL_HOURS;
    delete process.env.SCHEDULED_VERIFY_BATCH;
    expect(verifyIntervalHours()).toBe(168);
    expect(batchSize()).toBe(5);
  });

  it('honours env overrides and ignores nonsense', () => {
    process.env.SCHEDULED_VERIFY_INTERVAL_HOURS = '24';
    process.env.SCHEDULED_VERIFY_BATCH = '10';
    expect(verifyIntervalHours()).toBe(24);
    expect(batchSize()).toBe(10);

    process.env.SCHEDULED_VERIFY_INTERVAL_HOURS = 'weekly';
    process.env.SCHEDULED_VERIFY_BATCH = '-3';
    expect(verifyIntervalHours()).toBe(168);
    expect(batchSize()).toBe(5);
  });

  it('caps the batch so one invocation cannot try to sweep everything', () => {
    process.env.SCHEDULED_VERIFY_BATCH = '1000';
    expect(batchSize()).toBe(25);
  });

  // Derived from plans.ts so a pricing change doesn't silently diverge.
  it('derives eligible plans from the plan table', () => {
    expect(scheduledPlans()).toEqual(['business']);
  });
});

describe('findCandidates', () => {
  it('includes a claimed API on an eligible plan that has never been verified', async () => {
    const seeded = await seedApi();
    const found = await findCandidates(db, 50);
    expect(found.map((c) => c.slug)).toContain(seeded.slug);
  });

  it('excludes an unclaimed API', async () => {
    const seeded = await seedApi({ claimStatus: 'unclaimed' });
    const found = await findCandidates(db, 50);
    expect(found.map((c) => c.slug)).not.toContain(seeded.slug);
  });

  it('excludes plans without scheduled verification', async () => {
    for (const plan of ['free', 'launch', 'pro', 'team']) {
      const seeded = await seedApi({ plan });
      const found = await findCandidates(db, 50);
      expect(found.map((c) => c.slug)).not.toContain(seeded.slug);
    }
  });

  it('excludes an API verified more recently than the cadence', async () => {
    const seeded = await seedApi({ verifiedAt: new Date(Date.now() - 60 * 60 * 1000) }); // 1h ago
    const found = await findCandidates(db, 50);
    expect(found.map((c) => c.slug)).not.toContain(seeded.slug);
  });

  it('includes an API whose score is older than the cadence', async () => {
    const seeded = await seedApi({ verifiedAt: new Date(Date.now() - 200 * 60 * 60 * 1000) }); // 200h ago
    const found = await findCandidates(db, 50);
    expect(found.map((c) => c.slug)).toContain(seeded.slug);
  });

  it('respects a shortened cadence', async () => {
    const seeded = await seedApi({ verifiedAt: new Date(Date.now() - 5 * 60 * 60 * 1000) }); // 5h ago
    expect((await findCandidates(db, 50)).map((c) => c.slug)).not.toContain(seeded.slug);
    process.env.SCHEDULED_VERIFY_INTERVAL_HOURS = '1';
    expect((await findCandidates(db, 50)).map((c) => c.slug)).toContain(seeded.slug);
  });

  // Without stalest-first ordering plus a bounded batch, one API can be
  // re-verified every run while another is never reached.
  it('orders never-verified and stalest APIs first', async () => {
    const stale = await seedApi({ verifiedAt: new Date(Date.now() - 500 * 60 * 60 * 1000) });
    const staler = await seedApi({ verifiedAt: new Date(Date.now() - 900 * 60 * 60 * 1000) });
    const never = await seedApi();

    const found = await findCandidates(db, 50);
    const order = found.map((c) => c.slug);
    expect(order.indexOf(never.slug)).toBeLessThan(order.indexOf(staler.slug));
    expect(order.indexOf(staler.slug)).toBeLessThan(order.indexOf(stale.slug));
  });

  it('honours the batch limit', async () => {
    await seedApi();
    await seedApi();
    await seedApi();
    expect((await findCandidates(db, 2)).length).toBe(2);
  });

  it('surfaces the spec source url so the spec can be refreshed', async () => {
    const seeded = await seedApi({ sourceUrl: 'https://example.test/openapi.json' });
    const found = await findCandidates(db, 50);
    expect(found.find((c) => c.slug === seeded.slug)?.sourceUrl).toBe('https://example.test/openapi.json');
  });
});

describe('reverifyOne', () => {
  it('skips the spec refresh when there is no source url, and still scores', async () => {
    const seeded = await seedApi();
    const outcome = await reverifyOne(neonDb, candidateFor(seeded), {
      loadRecord: async () => record(),
      scoreEngine: async () => SCORE,
    });

    expect(outcome).toMatchObject({ specStatus: 'skipped', scored: true, total: 88 });
    const [score] = await db.select().from(schema.scores).where(eq(schema.scores.apiId, seeded.apiId));
    expect(score.total).toBe(88);
  });

  it('records a score run row on success', async () => {
    const seeded = await seedApi();
    await reverifyOne(neonDb, candidateFor(seeded), { loadRecord: async () => record(), scoreEngine: async () => SCORE });

    const runs = await db.select().from(schema.scoreRuns).where(eq(schema.scoreRuns.apiId, seeded.apiId));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('succeeded');
    expect(runs[0].completedAt).not.toBeNull();
  });

  it('refreshes the spec first and reports that it changed', async () => {
    const seeded = await seedApi({ sourceUrl: 'https://example.test/openapi.json' });
    const outcome = await reverifyOne(
      neonDb,
      candidateFor(seeded, { sourceUrl: 'https://example.test/openapi.json' }),
      {
        importSpec: async () => ({ record: record({ actions: [action(), action({ id: 'a2', name: 'other' })] }), rawText: '{"changed":true}' }),
        loadRecord: async () => record(),
        scoreEngine: async () => SCORE,
      },
    );

    expect(outcome.specStatus).toBe('updated');
    expect(outcome.scored).toBe(true);
    const versions = await db.select().from(schema.specVersions).where(eq(schema.specVersions.apiId, seeded.apiId));
    expect(versions.length).toBe(2);
  });

  // The common case in production: the cron runs daily, the spec rarely moves.
  // It must cost no spec rewrite while still refreshing the score.
  it('reports unchanged and writes no new spec version when the refetch is byte-identical', async () => {
    const seeded = await seedApi({ sourceUrl: 'https://example.test/openapi.json' });

    const outcome = await reverifyOne(
      neonDb,
      candidateFor(seeded, { sourceUrl: 'https://example.test/openapi.json' }),
      {
        // Exactly the bytes the seed persisted.
        importSpec: async () => ({ record: record(), rawText: seeded.rawText }),
        loadRecord: async () => record(),
        scoreEngine: async () => SCORE,
      },
    );

    expect(outcome.specStatus).toBe('unchanged');
    expect(outcome.scored).toBe(true);
    const versions = await db.select().from(schema.specVersions).where(eq(schema.specVersions.apiId, seeded.apiId));
    expect(versions).toHaveLength(1);
  });

  // A provider whose spec URL 404s must not block its score refresh, nor the
  // rest of the batch.
  it('scores anyway when the spec refetch fails', async () => {
    const seeded = await seedApi({ sourceUrl: 'https://gone.test/openapi.json' });
    const outcome = await reverifyOne(
      neonDb,
      candidateFor(seeded, { sourceUrl: 'https://gone.test/openapi.json' }),
      {
        importSpec: async () => {
          throw new Error('404');
        },
        loadRecord: async () => record(),
        scoreEngine: async () => SCORE,
      },
    );

    expect(outcome.specStatus).toBe('refetch_failed');
    expect(outcome.scored).toBe(true);
  });

  it('marks the run failed and reports an error when the probe engine throws', async () => {
    const seeded = await seedApi();
    const outcome = await reverifyOne(neonDb, candidateFor(seeded), {
      loadRecord: async () => record(),
      scoreEngine: async () => {
        throw new Error('upstream exploded');
      },
    });

    expect(outcome).toMatchObject({ scored: false, error: 'score_run_failed' });
    const runs = await db.select().from(schema.scoreRuns).where(eq(schema.scoreRuns.apiId, seeded.apiId));
    expect(runs[0].status).toBe('failed');
    // The provider's error text is not stored verbatim.
    expect(runs[0].error).toBe('Scheduled verification failed');
  });

  it('reports record_unavailable rather than throwing when the model cannot load', async () => {
    const seeded = await seedApi();
    const outcome = await reverifyOne(neonDb, candidateFor(seeded), {
      loadRecord: async () => null,
      scoreEngine: async () => SCORE,
    });
    expect(outcome).toMatchObject({ scored: false, error: 'record_unavailable' });
  });

  it('probes unauthenticated when the org has no vaulted credential', async () => {
    const seeded = await seedApi();
    let sawKey: string | undefined = 'unset';
    await reverifyOne(neonDb, candidateFor(seeded), {
      loadRecord: async () => record(),
      scoreEngine: async (_rec, opts) => {
        sawKey = opts?.upstreamKey;
        return SCORE;
      },
    });
    expect(sawKey).toBeUndefined();
  });

  it('probes with the vaulted credential when one exists, auditing it as cron', async () => {
    const seeded = await seedApi({ plan: 'business' });
    const { storeCredential } = await import('../vaultStore');
    await storeCredential(db, {
      orgId: seeded.orgId,
      apiId: seeded.apiId,
      environment: 'production',
      secret: 'fixture-cron-credential-0003',
      actor: { type: 'user' },
    });

    let sawKey: string | undefined;
    const outcome = await reverifyOne(neonDb, candidateFor(seeded), {
      loadRecord: async () => record(),
      scoreEngine: async (_rec, opts) => {
        sawKey = opts?.upstreamKey;
        return SCORE;
      },
    });

    expect(sawKey).toBe('fixture-cron-credential-0003');
    expect(outcome.usedVaultedCredential).toBe(true);

    const audit = await db
      .select()
      .from(schema.credentialAudit)
      .where(eq(schema.credentialAudit.orgId, seeded.orgId));
    expect(audit.some((a) => a.action === 'used' && a.actorType === 'cron')).toBe(true);
  });

  it('does not reach for a vaulted credential on a plan without the feature', async () => {
    const seeded = await seedApi({ plan: 'pro' });
    let sawKey: string | undefined = 'unset';
    const outcome = await reverifyOne(neonDb, candidateFor(seeded, { plan: 'pro' }), {
      loadRecord: async () => record(),
      scoreEngine: async (_rec, opts) => {
        sawKey = opts?.upstreamKey;
        return SCORE;
      },
    });
    expect(sawKey).toBeUndefined();
    expect(outcome.usedVaultedCredential).toBe(false);
  });

  it('treats an unrecognised plan string as free rather than granting the feature', async () => {
    const seeded = await seedApi({ plan: 'enterprise-custom' });
    const outcome = await reverifyOne(neonDb, candidateFor(seeded, { plan: 'enterprise-custom' }), {
      loadRecord: async () => record(),
      scoreEngine: async () => SCORE,
    });
    expect(outcome.usedVaultedCredential).toBe(false);
  });

  // The score has to be attributed to the version that was actually probed.
  it('attributes the score to the post-refresh spec version', async () => {
    const seeded = await seedApi({ sourceUrl: 'https://example.test/openapi.json' });
    await reverifyOne(
      neonDb,
      candidateFor(seeded, { sourceUrl: 'https://example.test/openapi.json' }),
      {
        importSpec: async () => ({ record: record(), rawText: '{"brand":"new"}' }),
        loadRecord: async () => record(),
        scoreEngine: async () => SCORE,
      },
    );

    const [api] = await db.select().from(schema.apis).where(eq(schema.apis.id, seeded.apiId));
    const [score] = await db.select().from(schema.scores).where(eq(schema.scores.apiId, seeded.apiId));
    expect(score.specVersionId).toBe(api.currentSpecVersionId);
    expect(score.specVersionId).not.toBe(seeded.specVersionId);
  });
});
