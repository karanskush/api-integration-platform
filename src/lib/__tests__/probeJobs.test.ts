// Queuing a sandbox write run: only with a consented sandbox key, only once at a time.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';

const published: Array<{ path: string; body: unknown }> = [];
let ready = true;
vi.mock('../queue', () => ({
  queueReady: () => ready,
  publishJob: async (path: string, body: unknown) => {
    published.push({ path, body });
  },
}));

const { enqueueSandboxWriteRun, maybeEnqueueSandboxWriteRun } = await import('../probeJobs');

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

afterEach(() => {
  published.length = 0;
  ready = true;
});

let seq = 0;
async function seed(consent: 'none' | 'no_write' | 'write') {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `PJ Org ${seq}`, slug: `pj-org-${seq}` }).returning();
  const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: `pj-api-${seq}`, name: `PJ API ${seq}` }).returning();
  const [version] = await db.insert(schema.specVersions).values({ apiId: api.id, source: 'openapi', contentHash: `pj-${seq}`, parseStatus: 'parsed' }).returning();
  let credentialId: string | null = null;
  if (consent !== 'none') {
    const [cred] = await db
      .insert(schema.credentials)
      .values({
        orgId: org.id,
        apiId: api.id,
        environment: 'sandbox',
        encryptedKey: 'c',
        iv: 'i',
        authTag: 'a',
        wrappedDek: 'w',
        keyVersion: 1,
        kmsKeyId: 'local',
        fingerprint: `fp-${seq}`,
        hint: 'abcd',
        writeConsentAt: consent === 'write' ? new Date() : null,
      })
      .returning();
    credentialId = cred.id;
  }
  return { apiId: api.id, specVersionId: version.id, credentialId };
}

describe('maybeEnqueueSandboxWriteRun', () => {
  it('queues a run when the sandbox key carries write consent', async () => {
    const ids = await seed('write');
    const result = await maybeEnqueueSandboxWriteRun(db, { apiId: ids.apiId, specVersionId: ids.specVersionId, triggeredBy: 'verify' });
    expect(result.queued).toBe(true);
    if (!result.queued) return;
    const [run] = await db.select().from(schema.probeRuns).where(eq(schema.probeRuns.id, result.runId));
    expect(run).toMatchObject({ status: 'queued', kind: 'write_lifecycle', environment: 'sandbox', triggeredBy: 'verify', credentialId: ids.credentialId });
    expect(run.budgetLimit).toBeGreaterThan(0);
    expect(run.effectBudget).toBeGreaterThan(0);
    expect(published).toEqual([{ path: '/api/jobs/probe-sandbox', body: { apiId: ids.apiId, specVersionId: ids.specVersionId, runId: result.runId } }]);
  });

  it('refuses without write consent, and without any sandbox key', async () => {
    const noConsent = await seed('no_write');
    expect(await maybeEnqueueSandboxWriteRun(db, { apiId: noConsent.apiId, specVersionId: noConsent.specVersionId, triggeredBy: 'cron' })).toEqual({ queued: false, reason: 'no_write_consent' });
    const none = await seed('none');
    expect(await maybeEnqueueSandboxWriteRun(db, { apiId: none.apiId, specVersionId: none.specVersionId, triggeredBy: 'cron' })).toEqual({ queued: false, reason: 'no_write_consent' });
    expect(published).toHaveLength(0);
  });

  it('does not queue a second run while one is in flight', async () => {
    const ids = await seed('write');
    const first = await maybeEnqueueSandboxWriteRun(db, { apiId: ids.apiId, specVersionId: ids.specVersionId, triggeredBy: 'verify' });
    expect(first.queued).toBe(true);
    const second = await maybeEnqueueSandboxWriteRun(db, { apiId: ids.apiId, specVersionId: ids.specVersionId, triggeredBy: 'cron' });
    expect(second).toEqual({ queued: false, reason: 'already_running' });
    expect(published).toHaveLength(1);
  });

  it('says so when the queue is not configured, before touching the database', async () => {
    ready = false;
    const ids = await seed('write');
    expect(await maybeEnqueueSandboxWriteRun(db, { apiId: ids.apiId, specVersionId: ids.specVersionId, triggeredBy: 'verify' })).toEqual({ queued: false, reason: 'queue_unavailable' });
    expect(await enqueueSandboxWriteRun(db, { apiId: ids.apiId, specVersionId: ids.specVersionId, credentialId: null, triggeredBy: 'owner' })).toEqual({ queued: false, reason: 'queue_unavailable' });
    expect(await db.select().from(schema.probeRuns).where(eq(schema.probeRuns.apiId, ids.apiId))).toHaveLength(0);
  });
});
