// Cleaning up what an earlier run left behind: the sealed id is opened only to
// address the DELETE, the outcome is written back, and three failures quarantine.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import type { Action, ImportRecord } from '../ir';
import type { invokeAction } from '../mcpTools';
import { MAX_CLEANUP_ATTEMPTS, reapLeakedResources } from '../probeGc';
import { credentialFingerprint, sealCredential } from '../vault';
import { resourceSealContext } from '../writeRun';

let db: TestDb;
const ENV = 'DOCENTAPI_MASTER_KEY';
const original = process.env[ENV];
const SENTINEL = 'tag_SENTINEL_gc_91af';

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

beforeEach(() => {
  process.env[ENV] = Buffer.alloc(32, 9).toString('base64');
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

const pathId = { type: 'object', required: ['tagId'], properties: { tagId: { type: 'string', 'x-docentapi-in': 'path' } } };
const act = (name: string, method: string, path: string): Action =>
  ({ id: `id_${name}`, name, description: '', method, path, paramsSchema: method === 'POST' ? { type: 'object', properties: {} } : pathId, auth: 'bearer', safety: method === 'GET' ? 'read' : 'write', examples: [] }) as Action;

const record: ImportRecord = {
  id: 'r',
  name: 'R',
  source: 'openapi',
  baseUrls: ['https://api.example.test'],
  auth: 'bearer',
  actions: [act('create_tag', 'POST', '/tags'), act('get_tag', 'GET', '/tags/{tagId}'), act('delete_tag', 'DELETE', '/tags/{tagId}')],
  counts: { total: 3, read: 1, write: 2, destructive: 0 },
  createdAt: 0,
  expiresAt: 0,
};

let seq = 0;
async function seedLeak(over: Partial<typeof schema.probeResources.$inferInsert> = {}) {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `GC Org ${seq}`, slug: `gc-org-${seq}` }).returning();
  const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: `gc-api-${seq}`, name: `GC API ${seq}` }).returning();
  const [version] = await db.insert(schema.specVersions).values({ apiId: api.id, source: 'openapi', contentHash: `gc-${seq}`, parseStatus: 'parsed' }).returning();
  const [run] = await db
    .insert(schema.probeRuns)
    .values({ apiId: api.id, specVersionId: version.id, environment: 'sandbox', kind: 'write_lifecycle', status: 'completed_with_quarantined_resources', triggeredBy: 'owner' })
    .returning();
  const ctx = resourceSealContext(org.id, api.id);
  const sealed = sealCredential(SENTINEL, ctx);
  const [row] = await db
    .insert(schema.probeResources)
    .values({
      runId: run.id,
      apiId: api.id,
      orgId: org.id,
      environment: 'sandbox',
      entity: 'tag',
      createActionKey: 'id_create_tag',
      deleteActionKey: 'id_delete_tag',
      resourceIdHash: credentialFingerprint(SENTINEL, ctx),
      resourceIdCiphertext: sealed.ciphertext,
      resourceIdIv: sealed.iv,
      resourceIdAuthTag: sealed.authTag,
      resourceIdWrappedDek: sealed.wrappedDek,
      resourceIdKeyVersion: sealed.keyVersion,
      idSource: 'body',
      cleanupStatus: 'deleted_unconfirmed',
      cleanupAttempts: 1,
      ...over,
    })
    .returning();
  return { orgId: org.id, apiId: api.id, rowId: row.id, runId: run.id };
}

type Seen = { method: string; tagId: unknown };
function stub(deleteStatus: number, readStatus: number) {
  const seen: Seen[] = [];
  const invoke = (async (action: Action, params: Record<string, unknown>) => {
    seen.push({ method: action.method, tagId: params.tagId });
    const status = action.method === 'DELETE' ? deleteStatus : readStatus;
    return { status, latencyMs: 1, bodyText: status === 404 ? '{"error":"gone"}' : '{"id":"x"}' };
  }) as typeof invokeAction;
  return { invoke, seen };
}

async function row(id: string) {
  const [r] = await db.select().from(schema.probeResources).where(eq(schema.probeResources.id, id));
  return r;
}

describe('reapLeakedResources', () => {
  it('opens the sealed id only to address the DELETE, confirms with a read, and NULLs the seal', async () => {
    const ids = await seedLeak();
    const api = stub(204, 404);
    const result = await reapLeakedResources(db, { ...ids, environment: 'sandbox', record, ctx: { record, invoke: api.invoke, environment: 'sandbox' }, runId: null });
    expect(result).toEqual({ attempted: 1, confirmed: 1, quarantined: 0, failed: 0 });
    expect(api.seen).toEqual([
      { method: 'DELETE', tagId: SENTINEL },
      { method: 'GET', tagId: SENTINEL },
    ]);
    const r = await row(ids.rowId);
    expect(r.cleanupStatus).toBe('deleted_confirmed');
    expect(r.cleanupAttempts).toBe(2);
    expect(r.resourceIdCiphertext).toBeNull();
    expect(r.resourceIdWrappedDek).toBeNull();
    expect(r.deletedAt).not.toBeNull();
    const attempts = await db.select().from(schema.probeCleanupAttempts).where(eq(schema.probeCleanupAttempts.resourceId, ids.rowId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ deleteStatus: 204, readbackStatus: 404, result: 'deleted_confirmed' });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  it('a DELETE the provider refuses stays delete_failed while attempts remain', async () => {
    const ids = await seedLeak();
    const api = stub(500, 200);
    const result = await reapLeakedResources(db, { ...ids, environment: 'sandbox', record, ctx: { record, invoke: api.invoke, environment: 'sandbox' } });
    expect(result.failed).toBe(1);
    const r = await row(ids.rowId);
    expect(r.cleanupStatus).toBe('delete_failed');
    expect(r.resourceIdCiphertext).not.toBeNull();
    // No read after a failed delete.
    expect(api.seen.map((s) => s.method)).toEqual(['DELETE']);
  });

  it('quarantines after the last permitted attempt rather than retrying forever', async () => {
    const ids = await seedLeak({ cleanupAttempts: MAX_CLEANUP_ATTEMPTS - 1 });
    const api = stub(500, 200);
    const result = await reapLeakedResources(db, { ...ids, environment: 'sandbox', record, ctx: { record, invoke: api.invoke, environment: 'sandbox' } });
    expect(result.quarantined).toBe(1);
    const r = await row(ids.rowId);
    expect(r.cleanupStatus).toBe('quarantined');
    // The seal stays: a person may still want to remove it by hand.
    expect(r.resourceIdCiphertext).not.toBeNull();
  });

  it('an object still readable after a 204 is unconfirmed, not confirmed', async () => {
    const ids = await seedLeak();
    const api = stub(204, 200);
    await reapLeakedResources(db, { ...ids, environment: 'sandbox', record, ctx: { record, invoke: api.invoke, environment: 'sandbox' } });
    const r = await row(ids.rowId);
    expect(r.cleanupStatus).toBe('deleted_unconfirmed');
    const attempts = await db.select().from(schema.probeCleanupAttempts).where(eq(schema.probeCleanupAttempts.resourceId, ids.rowId));
    expect(attempts[0].result).toBe('still_readable');
  });

  it('a delete action the spec no longer has quarantines the fixture without a call', async () => {
    const ids = await seedLeak({ deleteActionKey: 'id_gone' });
    const api = stub(204, 404);
    const result = await reapLeakedResources(db, { ...ids, environment: 'sandbox', record, ctx: { record, invoke: api.invoke, environment: 'sandbox' } });
    expect(result.quarantined).toBe(1);
    expect(api.seen).toHaveLength(0);
  });

  it('leaves quarantined and confirmed rows alone, and other environments too', async () => {
    const a = await seedLeak({ cleanupStatus: 'quarantined' });
    const b = await seedLeak({ cleanupStatus: 'deleted_confirmed', resourceIdCiphertext: null });
    const c = await seedLeak({ environment: 'production' });
    for (const ids of [a, b, c]) {
      const api = stub(204, 404);
      const result = await reapLeakedResources(db, { ...ids, environment: 'sandbox', record, ctx: { record, invoke: api.invoke, environment: 'sandbox' } });
      expect(result.attempted).toBe(0);
      expect(api.seen).toHaveLength(0);
    }
  });
});
