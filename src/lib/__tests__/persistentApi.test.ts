// persistentApi.ts had zero test coverage before this file: loadPersistentRecord
// and friends call getDb() internally, so exercising them means either a live
// Neon connection or replacing the './db' module — the same seam
// visibility.test.ts already established. This mocks that seam to run the real
// functions against the pglite test harness instead.

import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';

let db: TestDb;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

beforeEach(() => {
  // dbReady() only checks that DATABASE_URL is set; getDb() is what actually
  // connects, and that is what the mock below replaces.
  process.env.DATABASE_URL = 'postgres://stub/stub';
});

afterEach(() => {
  vi.resetModules();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

async function loadModule() {
  vi.resetModules();
  vi.doMock('../db', () => ({
    dbReady: () => Boolean(process.env.DATABASE_URL),
    getDb: () => db,
  }));
  return import('../persistentApi');
}

let seq = 0;
async function seedApi(overrides: Partial<typeof schema.apis.$inferInsert> = {}) {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `PA Org ${seq}`, slug: `pa-org-${seq}` }).returning();
  const [api] = await db
    .insert(schema.apis)
    .values({
      orgId: org.id,
      slug: `pa-api-${seq}`,
      name: `PA API ${seq}`,
      baseUrls: ['https://api.example.com'],
      dominantAuth: 'oauth2',
      ...overrides,
    })
    .returning();
  const [version] = await db
    .insert(schema.specVersions)
    .values({ apiId: api.id, source: 'openapi', sourceUrl: 'https://spec.example.com/openapi.json', contentHash: `hash-${seq}`, parseStatus: 'parsed' })
    .returning();
  await db.update(schema.apis).set({ currentSpecVersionId: version.id }).where(eq(schema.apis.id, api.id));
  return { orgId: org.id, apiId: api.id, slug: api.slug, specVersionId: version.id };
}

async function addAction(specVersionId: string, apiId: string, overrides: Partial<typeof schema.actions.$inferInsert> = {}) {
  await db.insert(schema.actions).values({
    apiId,
    specVersionId,
    actionKey: 'action-key-1',
    name: 'do_thing',
    description: 'Does a thing',
    method: 'POST',
    path: '/things',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'oauth2',
    safety: 'write',
    ...overrides,
  });
}

describe('loadPersistentRecord', () => {
  it('returns null when persistence is not configured', async () => {
    delete process.env.DATABASE_URL;
    const { loadPersistentRecord } = await loadModule();
    expect(await loadPersistentRecord('anything')).toBeNull();
  });

  it('returns null for an unknown slug', async () => {
    const { loadPersistentRecord } = await loadModule();
    expect(await loadPersistentRecord('no-such-slug')).toBeNull();
  });

  it('returns null when the api has no current spec version', async () => {
    const { loadPersistentRecord } = await loadModule();
    const seq2 = ++seq;
    const [org] = await db.insert(schema.orgs).values({ name: `Bare Org ${seq2}`, slug: `bare-org-${seq2}` }).returning();
    const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: `bare-api-${seq2}`, name: 'Bare' }).returning();
    expect(api.currentSpecVersionId).toBeNull();
    expect(await loadPersistentRecord(api.slug)).toBeNull();
  });

  it('restores baseUrls, dominant auth, source, and sourceUrl onto the record', async () => {
    const { loadPersistentRecord } = await loadModule();
    const { specVersionId, apiId, slug } = await seedApi();
    await addAction(specVersionId, apiId);

    const record = await loadPersistentRecord(slug);
    expect(record).toMatchObject({
      id: slug,
      source: 'openapi',
      sourceUrl: 'https://spec.example.com/openapi.json',
      baseUrls: ['https://api.example.com'],
      auth: 'oauth2',
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
  });

  it('sets the action id to the stable actionKey, not the row uuid', async () => {
    const { loadPersistentRecord } = await loadModule();
    const { specVersionId, apiId, slug } = await seedApi();
    await addAction(specVersionId, apiId, { actionKey: 'stable-key-abc' });

    const record = await loadPersistentRecord(slug);
    expect(record?.actions[0].id).toBe('stable-key-abc');
  });

  // The three fields added across this session's work — none had a
  // regression test confirming they survive the DB round trip until now.
  it('restores responseSchema, errorSchema, and scopes', async () => {
    const { loadPersistentRecord } = await loadModule();
    const { specVersionId, apiId, slug } = await seedApi();
    await addAction(specVersionId, apiId, {
      responseSchemas: { type: 'object', properties: { id: { type: 'string' } } },
      errorSchemas: { type: 'object', properties: { code: { type: 'string' } } },
      scopes: ['write:things'],
    });

    const record = await loadPersistentRecord(slug);
    const action = record?.actions[0];
    expect(action?.responseSchema).toEqual({ type: 'object', properties: { id: { type: 'string' } } });
    expect(action?.errorSchema).toEqual({ type: 'object', properties: { code: { type: 'string' } } });
    expect(action?.scopes).toEqual(['write:things']);
  });

  it('leaves responseSchema, errorSchema, scopes, and authIn undefined rather than null when unset', async () => {
    const { loadPersistentRecord } = await loadModule();
    const { specVersionId, apiId, slug } = await seedApi();
    await addAction(specVersionId, apiId);

    const action = (await loadPersistentRecord(slug))?.actions[0];
    expect(action?.responseSchema).toBeUndefined();
    expect(action?.errorSchema).toBeUndefined();
    expect(action?.scopes).toBeUndefined();
    expect(action?.authIn).toBeUndefined();
  });

  it('restores authIn placement when set', async () => {
    const { loadPersistentRecord } = await loadModule();
    const { specVersionId, apiId, slug } = await seedApi();
    await addAction(specVersionId, apiId, { authIn: { in: 'header', name: 'X-Api-Key' } });

    expect((await loadPersistentRecord(slug))?.actions[0].authIn).toEqual({ in: 'header', name: 'X-Api-Key' });
  });

  it('defaults examples to an empty array rather than null', async () => {
    const { loadPersistentRecord } = await loadModule();
    const { specVersionId, apiId, slug } = await seedApi();
    await addAction(specVersionId, apiId);

    expect((await loadPersistentRecord(slug))?.actions[0].examples).toEqual([]);
  });

  it('recomputes counts from the restored actions rather than trusting a stored total', async () => {
    const { loadPersistentRecord } = await loadModule();
    const { specVersionId, apiId, slug } = await seedApi();
    await addAction(specVersionId, apiId, { actionKey: 'k1', name: 'read_one', safety: 'read' });
    await addAction(specVersionId, apiId, { actionKey: 'k2', name: 'write_one', safety: 'write' });
    await addAction(specVersionId, apiId, { actionKey: 'k3', name: 'delete_one', safety: 'destructive' });

    const record = await loadPersistentRecord(slug);
    expect(record?.counts).toEqual({ total: 3, read: 1, write: 1, destructive: 1 });
  });

  it('only restores actions belonging to the current spec version', async () => {
    const { loadPersistentRecord } = await loadModule();
    const { specVersionId, apiId, slug } = await seedApi();
    await addAction(specVersionId, apiId, { actionKey: 'current', name: 'current_action' });

    // A second, older spec version's action must not leak into the record.
    const [oldVersion] = await db
      .insert(schema.specVersions)
      .values({ apiId, source: 'openapi', contentHash: 'old-hash', parseStatus: 'parsed' })
      .returning();
    await addAction(oldVersion.id, apiId, { actionKey: 'stale', name: 'stale_action' });

    const record = await loadPersistentRecord(slug);
    expect(record?.actions.map((a) => a.name)).toEqual(['current_action']);
  });
});

describe('loadRecordForVersion', () => {
  it('returns null when persistence is not configured', async () => {
    delete process.env.DATABASE_URL;
    const { loadRecordForVersion } = await loadModule();
    expect(await loadRecordForVersion('any', 'any')).toBeNull();
  });

  it('returns null for an unknown apiId', async () => {
    const { loadRecordForVersion } = await loadModule();
    expect(await loadRecordForVersion('00000000-0000-0000-0000-000000000000', 'any')).toBeNull();
  });

  // The reason this function exists rather than reusing loadPersistentRecord:
  // a background job is launched against a specific spec version and must
  // keep reading THAT version even if a re-import makes a newer one current
  // while the job is still in flight.
  it('loads a specific version even when a newer one has since become current', async () => {
    const { loadRecordForVersion } = await loadModule();
    const { apiId, specVersionId } = await seedApi();
    await addAction(specVersionId, apiId, { actionKey: 'k1', name: 'action_one' });

    const [newerVersion] = await db
      .insert(schema.specVersions)
      .values({ apiId, source: 'openapi', contentHash: 'newer-hash', parseStatus: 'parsed' })
      .returning();
    await db.update(schema.apis).set({ currentSpecVersionId: newerVersion.id }).where(eq(schema.apis.id, apiId));
    await addAction(newerVersion.id, apiId, { actionKey: 'k2', name: 'action_two' });

    const record = await loadRecordForVersion(apiId, specVersionId);
    expect(record?.actions.map((a) => a.name)).toEqual(['action_one']);
  });

  it('restores the same field shapes loadPersistentRecord does', async () => {
    const { loadRecordForVersion } = await loadModule();
    const { apiId, specVersionId, slug } = await seedApi();
    await addAction(specVersionId, apiId, { scopes: ['read:things'] });

    const record = await loadRecordForVersion(apiId, specVersionId);
    expect(record).toMatchObject({ id: slug, source: 'openapi', auth: 'oauth2', expiresAt: Number.MAX_SAFE_INTEGER });
    expect(record?.actions[0].scopes).toEqual(['read:things']);
  });
});

describe('loadApiVerificationState', () => {
  it('returns null when persistence is not configured', async () => {
    delete process.env.DATABASE_URL;
    const { loadApiVerificationState } = await loadModule();
    expect(await loadApiVerificationState('anything')).toBeNull();
  });

  it('returns null for an unknown slug', async () => {
    const { loadApiVerificationState } = await loadModule();
    expect(await loadApiVerificationState('no-such-slug')).toBeNull();
  });

  it('reports claimStatus with scores null when no score row exists', async () => {
    const { loadApiVerificationState } = await loadModule();
    const { slug } = await seedApi({ claimStatus: 'claimed' });
    expect(await loadApiVerificationState(slug)).toEqual({ orgId: expect.any(String), claimStatus: 'claimed', scores: null });
  });

  it('includes the verified score when one exists', async () => {
    const { loadApiVerificationState } = await loadModule();
    const { apiId, specVersionId, slug } = await seedApi({ claimStatus: 'claimed' });
    await db.insert(schema.scores).values({
      apiId,
      specVersionId,
      total: 82,
      authClarity: 25,
      errorQuality: 20,
      docDrift: null,
      idempotency: 18,
      explanation: [{ factId: 'f1', message: 'ok' }],
    });

    const state = await loadApiVerificationState(slug);
    expect(state?.scores).toMatchObject({ total: 82, authClarity: 25, errorQuality: 20, docDrift: null, idempotency: 18 });
  });
});

describe('loadVerifiedApiIds', () => {
  it('returns an empty set for an empty input without querying', async () => {
    const { loadVerifiedApiIds } = await loadModule();
    expect(await loadVerifiedApiIds([])).toEqual(new Set());
  });

  it('returns an empty set when persistence is not configured', async () => {
    delete process.env.DATABASE_URL;
    const { loadVerifiedApiIds } = await loadModule();
    expect(await loadVerifiedApiIds(['id-1'])).toEqual(new Set());
  });

  it('returns only the ids that have a score row', async () => {
    const { loadVerifiedApiIds } = await loadModule();
    const a = await seedApi();
    const b = await seedApi();
    await db.insert(schema.scores).values({
      apiId: a.apiId,
      specVersionId: a.specVersionId,
      total: 50,
      authClarity: 12,
      errorQuality: null,
      docDrift: null,
      idempotency: 12,
      explanation: [],
    });

    const verified = await loadVerifiedApiIds([a.apiId, b.apiId]);
    expect(verified.has(a.apiId)).toBe(true);
    expect(verified.has(b.apiId)).toBe(false);
  });
});
