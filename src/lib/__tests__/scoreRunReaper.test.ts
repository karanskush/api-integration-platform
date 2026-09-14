// A score run whose function died keeps claiming to be in progress. score_runs
// is the audit trail for "did we probe this API and what happened", so a row
// permanently asserting `running` is the table contradicting itself.

import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { ABANDONED_AFTER_MS, reapAbandonedScoreRuns } from '../scoreRunReaper';
import { buildPersistStatements } from '../persist';
import type { ImportRecord } from '../ir';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

let seq = 0;
async function seedApi() {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `Reap ${seq}`, slug: `reap-${seq}` }).returning();
  const record: ImportRecord = {
    id: 'r',
    name: `Reap API ${seq}`,
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'none',
    actions: [],
    counts: { total: 0, read: 0, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
  };
  const built = await buildPersistStatements(db, { orgId: org.id, record, rawText: `{"reap":${seq}}` });
  for (const statement of built.statements) await statement;
  return built.apiId;
}

const NOW = new Date('2026-09-08T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

async function insertRun(apiId: string, status: string, startedAt: Date) {
  const [row] = await db.insert(schema.scoreRuns).values({ apiId, status, startedAt }).returning();
  return row.id;
}

const statusOf = async (id: string) => {
  const [row] = await db.select().from(schema.scoreRuns).where(eq(schema.scoreRuns.id, id));
  return row;
};

describe('reaping abandoned score runs', () => {
  it('closes a running row older than the cutoff', async () => {
    const apiId = await seedApi();
    const id = await insertRun(apiId, 'running', ago(ABANDONED_AFTER_MS + 60_000));

    expect(await reapAbandonedScoreRuns(db, NOW)).toBe(1);

    const row = await statusOf(id);
    expect(row.status).toBe('failed');
    expect(row.completedAt).not.toBeNull();
  });

  // Closed vocabulary, never a message — the rule every other persisted error
  // in this codebase follows, because a message is how a URL or an identifier
  // ends up in a column.
  it('records a reason from a closed vocabulary', async () => {
    const apiId = await seedApi();
    const id = await insertRun(apiId, 'running', ago(ABANDONED_AFTER_MS + 1));

    await reapAbandonedScoreRuns(db, NOW);
    expect((await statusOf(id)).error).toBe('abandoned');
  });

  // The cutoff sits well past the 300s function ceiling precisely so this
  // cannot happen: reaping a live run would have it overwrite its own terminal
  // state moments later.
  it('leaves a run that could still be executing alone', async () => {
    const apiId = await seedApi();
    const id = await insertRun(apiId, 'running', ago(60_000));

    expect(await reapAbandonedScoreRuns(db, NOW)).toBe(0);
    expect((await statusOf(id)).status).toBe('running');
  });

  it('never touches a run that already reached a terminal state', async () => {
    const apiId = await seedApi();
    const old = ago(ABANDONED_AFTER_MS * 10);
    const succeeded = await insertRun(apiId, 'succeeded', old);
    const failed = await insertRun(apiId, 'failed', old);

    await reapAbandonedScoreRuns(db, NOW);

    expect((await statusOf(succeeded)).status).toBe('succeeded');
    expect((await statusOf(failed)).status).toBe('failed');
    expect((await statusOf(failed)).error).toBeNull();
  });

  it('reports nothing to close when there is nothing abandoned', async () => {
    expect(await reapAbandonedScoreRuns(db, new Date('2020-01-01T00:00:00.000Z'))).toBe(0);
  });
});
