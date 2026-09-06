// The spec poller. Network is replaced at two seams, both plain function
// parameters (the claims.ts FetchImpl precedent) rather than vi.mock: a fake
// `fetchImpl` for the conditional GET itself, and PollDeps for pollOne.

import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { NeonDb } from '../db';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import type { Action, ImportRecord } from '../ir';
import { buildPersistStatements } from '../persist';
import { SsrfError, UpstreamError, type SafeFetchOptions, type SafeFetchResult } from '../ssrf';
import {
  fetchSpecConditional,
  findPollCandidates,
  pollBatchSize,
  pollIntervalHours,
  pollOne,
  type PollCandidate,
} from '../specPoll';

let db: TestDb;
let neonDb: NeonDb;

const ENV_KEYS = ['SPEC_POLL_INTERVAL_HOURS', 'SPEC_POLL_INTERVAL_HOURS_FREE', 'SPEC_POLL_BATCH'] as const;
const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  db = await createTestDb();
  // reimportApi calls .batch(), which only neon-http implements; the
  // statements are thenables, so a sequential shim exercises the real write
  // path against pglite (same approach as reverify.test.ts).
  (db as unknown as { batch: (items: Promise<unknown>[]) => Promise<unknown[]> }).batch = async (items) => {
    const out: unknown[] = [];
    for (const item of items) out.push(await item);
    return out;
  };
  neonDb = db as unknown as NeonDb;
}, 30_000);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original[key];
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
    auth: 'none',
    safety: 'read',
    examples: [],
    ...overrides,
  };
}

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  const actions = overrides.actions ?? [action()];
  return {
    id: 'sp',
    name: 'Poll API',
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'none',
    actions,
    counts: { total: actions.length, read: actions.length, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

let seq = 0;
async function seedApi(opts: { plan?: string; claimStatus?: string; sourceUrl?: string | null; lastPolledAt?: Date; etag?: string } = {}) {
  seq += 1;
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: `SP Org ${seq}`, slug: `sp-org-${seq}`, plan: opts.plan ?? 'pro' })
    .returning();

  const rawText = `{"v":${seq}}`;
  const built = await buildPersistStatements(db, { orgId: org.id, record: record(), rawText });
  for (const statement of built.statements) await statement;

  await db
    .update(schema.apis)
    .set({ claimStatus: opts.claimStatus ?? 'claimed' })
    .where(eq(schema.apis.id, built.apiId));

  const sourceUrl = opts.sourceUrl === undefined ? `https://spec.example.test/${seq}.json` : opts.sourceUrl;
  await db
    .update(schema.specVersions)
    .set({ sourceUrl, lastPolledAt: opts.lastPolledAt ?? null, etag: opts.etag ?? null })
    .where(eq(schema.specVersions.id, built.specVersionId));

  return { orgId: org.id, apiId: built.apiId, slug: built.slug, specVersionId: built.specVersionId, sourceUrl, rawText };
}

function candidateFor(seeded: Awaited<ReturnType<typeof seedApi>>, overrides: Partial<PollCandidate> = {}): PollCandidate {
  return {
    apiId: seeded.apiId,
    slug: seeded.slug,
    orgId: seeded.orgId,
    plan: 'pro',
    specVersionId: seeded.specVersionId,
    sourceUrl: seeded.sourceUrl ?? 'https://spec.example.test/x.json',
    etag: null,
    lastModified: null,
    lastPolledAt: null,
    ...overrides,
  };
}

function fetchResult(overrides: Partial<SafeFetchResult> = {}): SafeFetchResult {
  return {
    status: 200,
    headers: new Headers(),
    body: new TextEncoder().encode('{}'),
    finalUrl: 'https://spec.example.test/x.json',
    latencyMs: 1,
    ...overrides,
  };
}

async function versionRow(specVersionId: string) {
  const [row] = await db.select().from(schema.specVersions).where(eq(schema.specVersions.id, specVersionId));
  return row;
}

describe('configuration', () => {
  it('polls paid plans hourly and free plans daily by default', () => {
    expect(pollIntervalHours('pro')).toBe(1);
    expect(pollIntervalHours('business')).toBe(1);
    expect(pollIntervalHours('free')).toBe(24);
  });

  // An unrecognised plan string must not buy the faster cadence.
  it('treats an unknown plan as free', () => {
    expect(pollIntervalHours('enterprise-legacy')).toBe(24);
  });

  it('honours env overrides and ignores nonsense', () => {
    process.env.SPEC_POLL_INTERVAL_HOURS = '6';
    process.env.SPEC_POLL_INTERVAL_HOURS_FREE = 'soon';
    expect(pollIntervalHours('pro')).toBe(6);
    expect(pollIntervalHours('free')).toBe(24);
  });

  it('caps the batch so one invocation cannot try to sweep everything', () => {
    process.env.SPEC_POLL_BATCH = '5000';
    expect(pollBatchSize()).toBe(100);
    process.env.SPEC_POLL_BATCH = '7';
    expect(pollBatchSize()).toBe(7);
  });
});

describe('fetchSpecConditional', () => {
  it('sends no conditional headers when there are no stored validators', async () => {
    let seen: SafeFetchOptions | undefined;
    await fetchSpecConditional('https://spec.example.test/x.json', {}, async (_url, opts) => {
      seen = opts;
      return fetchResult();
    });
    expect(seen?.headers).toBeDefined();
    expect(seen?.headers?.['if-none-match']).toBeUndefined();
    expect(seen?.headers?.['if-modified-since']).toBeUndefined();
  });

  it('sends both validators when both are stored', async () => {
    let seen: SafeFetchOptions | undefined;
    await fetchSpecConditional(
      'https://spec.example.test/x.json',
      { etag: 'W/"abc"', lastModified: 'Wed, 01 Jul 2026 00:00:00 GMT' },
      async (_url, opts) => {
        seen = opts;
        return fetchResult();
      },
    );
    expect(seen?.headers?.['if-none-match']).toBe('W/"abc"');
    expect(seen?.headers?.['if-modified-since']).toBe('Wed, 01 Jul 2026 00:00:00 GMT');
  });

  it('reads a 304 as not_modified', async () => {
    const result = await fetchSpecConditional('https://spec.example.test/x.json', { etag: '"a"' }, async () =>
      fetchResult({ status: 304, body: new Uint8Array() }),
    );
    expect(result).toEqual({ status: 'not_modified' });
  });

  it('returns the body and the new validators on a 200', async () => {
    const result = await fetchSpecConditional('https://spec.example.test/x.json', {}, async () =>
      fetchResult({
        body: new TextEncoder().encode('{"openapi":"3.0.0"}'),
        headers: new Headers({ etag: '"v2"', 'last-modified': 'Thu, 02 Jul 2026 00:00:00 GMT' }),
      }),
    );
    expect(result).toMatchObject({ status: 'ok', text: '{"openapi":"3.0.0"}', etag: '"v2"', lastModified: 'Thu, 02 Jul 2026 00:00:00 GMT' });
  });

  it('reports an HTTP error by status, never by body', async () => {
    const result = await fetchSpecConditional('https://spec.example.test/x.json', {}, async () =>
      fetchResult({ status: 404, body: new TextEncoder().encode('<html>gone, contact ops@example</html>') }),
    );
    expect(result).toEqual({ status: 'failed', reason: 'http_404' });
  });

  // Provider error text can echo request content; only the error NAME is kept.
  it('reports a thrown transport or policy error by name', async () => {
    const ssrf = await fetchSpecConditional('https://spec.example.test/x.json', {}, async () => {
      throw new SsrfError('blocked private address 10.0.0.1');
    });
    expect(ssrf).toEqual({ status: 'failed', reason: 'SsrfError' });

    const upstream = await fetchSpecConditional('https://spec.example.test/x.json', {}, async () => {
      throw new UpstreamError('timed out talking to secret.internal');
    });
    expect(upstream).toEqual({ status: 'failed', reason: 'UpstreamError' });
  });
});

describe('findPollCandidates', () => {
  it('includes a claimed API with a source url, on the free plan too', async () => {
    const seeded = await seedApi({ plan: 'free' });
    const found = await findPollCandidates(db, 50);
    expect(found.map((c) => c.slug)).toContain(seeded.slug);
  });

  it('excludes an unclaimed API and one whose spec was pasted rather than fetched', async () => {
    const unclaimed = await seedApi({ claimStatus: 'unclaimed' });
    const pasted = await seedApi({ sourceUrl: null });
    const slugs = (await findPollCandidates(db, 50)).map((c) => c.slug);
    expect(slugs).not.toContain(unclaimed.slug);
    expect(slugs).not.toContain(pasted.slug);
  });

  it('applies the per-plan cadence: a free API polled 2h ago waits, a paid one does not', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    const free = await seedApi({ plan: 'free', lastPolledAt: twoHoursAgo });
    const paid = await seedApi({ plan: 'pro', lastPolledAt: twoHoursAgo });

    const slugs = (await findPollCandidates(db, 50)).map((c) => c.slug);
    expect(slugs).not.toContain(free.slug);
    expect(slugs).toContain(paid.slug);
  });

  it('orders never-polled first, then longest-unpolled', async () => {
    const recent = await seedApi({ lastPolledAt: new Date(Date.now() - 2 * 3600 * 1000) });
    const older = await seedApi({ lastPolledAt: new Date(Date.now() - 40 * 3600 * 1000) });
    const never = await seedApi();

    const order = (await findPollCandidates(db, 50)).map((c) => c.slug);
    expect(order.indexOf(never.slug)).toBeLessThan(order.indexOf(older.slug));
    expect(order.indexOf(older.slug)).toBeLessThan(order.indexOf(recent.slug));
  });

  it('honours the batch limit and carries the stored validators', async () => {
    const seeded = await seedApi({ etag: '"stored-etag"' });
    expect((await findPollCandidates(db, 1)).length).toBe(1);
    const found = (await findPollCandidates(db, 50)).find((c) => c.slug === seeded.slug);
    expect(found?.etag).toBe('"stored-etag"');
    expect(found?.sourceUrl).toBe(seeded.sourceUrl);
  });
});

describe('pollOne', () => {
  it('records a 304 without touching versions, and still stamps last_polled_at', async () => {
    const seeded = await seedApi();
    const outcome = await pollOne(neonDb, candidateFor(seeded), { fetchSpec: async () => ({ status: 'not_modified' }) });

    expect(outcome.status).toBe('not_modified');
    const row = await versionRow(seeded.specVersionId);
    expect(row.pollStatus).toBe('not_modified');
    expect(row.lastPolledAt).not.toBeNull();
    const versions = await db.select().from(schema.specVersions).where(eq(schema.specVersions.apiId, seeded.apiId));
    expect(versions).toHaveLength(1);
  });

  it('creates a version, classifies the change, and stores validators on the new current row', async () => {
    const seeded = await seedApi();
    const changed = record({ actions: [action(), action({ id: 'a2', name: 'list_things', path: '/things/all' })] });
    const outcome = await pollOne(neonDb, candidateFor(seeded), {
      fetchSpec: async () => ({ status: 'ok', text: '{"v":"new"}', etag: '"fresh"', lastModified: 'Thu, 02 Jul 2026 00:00:00 GMT', finalUrl: seeded.sourceUrl! }),
      importSpec: async () => ({ record: changed, rawText: '{"v":"new"}' }),
    });

    expect(outcome.status).toBe('updated');
    expect(outcome.counts?.additive).toBeGreaterThan(0);

    const [api] = await db.select().from(schema.apis).where(eq(schema.apis.id, seeded.apiId));
    const current = await versionRow(api.currentSpecVersionId!);
    expect(current.id).not.toBe(seeded.specVersionId);
    expect(current.etag).toBe('"fresh"');
    expect(current.lastModified).toBe('Thu, 02 Jul 2026 00:00:00 GMT');
    expect(current.pollStatus).toBe('ok');
    expect(current.lastPolledAt).not.toBeNull();

    // The change reached the ledger through the shared reimport path.
    const changes = await db.select().from(schema.apiChanges).where(eq(schema.apiChanges.apiId, seeded.apiId));
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.source === 'poll')).toBe(true);
  });

  // An ETag-less server that returns the same bytes: no new version, but the
  // validators and the poll stamp still belong on the row being served.
  it('stores validators on the existing row when the bytes are unchanged', async () => {
    const seeded = await seedApi();
    const outcome = await pollOne(neonDb, candidateFor(seeded), {
      fetchSpec: async () => ({ status: 'ok', text: seeded.rawText, etag: '"same"', finalUrl: seeded.sourceUrl! }),
      importSpec: async () => ({ record: record(), rawText: seeded.rawText }),
    });

    expect(outcome.status).toBe('unchanged');
    const row = await versionRow(seeded.specVersionId);
    expect(row.etag).toBe('"same"');
    expect(row.pollStatus).toBe('ok');
  });

  it('records a fetch failure by reason and keeps the served version intact', async () => {
    const seeded = await seedApi();
    const outcome = await pollOne(neonDb, candidateFor(seeded), {
      fetchSpec: async () => ({ status: 'failed', reason: 'http_404' }),
    });

    expect(outcome).toMatchObject({ status: 'failed', error: 'http_404' });
    const row = await versionRow(seeded.specVersionId);
    expect(row.pollStatus).toBe('failed');
    expect(row.pollError).toBe('http_404');
    // Stamped even on failure, or a permanently-404 spec starves the queue.
    expect(row.lastPolledAt).not.toBeNull();
  });

  it('never throws when the fetched spec stops parsing, and logs only the error name', async () => {
    const seeded = await seedApi();
    const outcome = await pollOne(neonDb, candidateFor(seeded), {
      fetchSpec: async () => ({ status: 'ok', text: 'not a spec', finalUrl: seeded.sourceUrl! }),
      importSpec: async () => {
        throw new (class ParseError extends Error {
          constructor() {
            super('unexpected token at line 1 of https://spec.example.test/secret');
            this.name = 'ParseError';
          }
        })();
      },
    });

    expect(outcome).toMatchObject({ status: 'failed', error: 'ParseError' });
    const row = await versionRow(seeded.specVersionId);
    expect(row.pollError).toBe('ParseError');
  });

  it('marks a non-http source url unsupported rather than attempting a fetch', async () => {
    const seeded = await seedApi();
    let fetched = false;
    const outcome = await pollOne(neonDb, candidateFor(seeded, { sourceUrl: 'file:///etc/passwd' }), {
      fetchSpec: async () => {
        fetched = true;
        return { status: 'not_modified' };
      },
    });

    expect(outcome.status).toBe('unsupported');
    expect(fetched).toBe(false);
    expect((await versionRow(seeded.specVersionId)).pollStatus).toBe('unsupported');
  });
});

describe('pollOne timestamps', () => {
  // A fetch takes seconds. Stamping the poll's START time made "last checked"
  // read as earlier than the spec version that same poll had just created.
  it('stamps last_polled_at at write time, not when the poll began', async () => {
    const seeded = await seedApi();
    const before = new Date();

    await pollOne(neonDb, candidateFor(seeded), {
      fetchSpec: async () => {
        // Stand in for a slow provider.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { status: 'not_modified' };
      },
    });

    const row = await versionRow(seeded.specVersionId);
    expect(row.lastPolledAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
