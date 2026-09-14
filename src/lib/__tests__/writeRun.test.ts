// Persisting a write run on real Postgres via PGlite: the §12.11 state, the
// ledger with its sealed identifiers, and the whole-database sentinel scan
// that proves a confirmed-deleted fixture's id survives nowhere but as a hash.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import type { CreatedResource, WriteRunResult } from '../probes/writeRunner';
import { makeRef } from '../transient';
import { credentialFingerprint, openCredential } from '../vault';
import { buildWriteRunStatements, liveObjectsByEntity, loadCleanupContracts, resourceSealContext } from '../writeRun';

let db: TestDb;

const ENV = 'DOCENTAPI_MASTER_KEY';
const original = process.env[ENV];
const SENTINEL = 'tag_SENTINEL_4e2b9c';

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

beforeEach(() => {
  process.env[ENV] = Buffer.alloc(32, 7).toString('base64');
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

let seq = 0;
async function seed() {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `WR Org ${seq}`, slug: `wr-org-${seq}` }).returning();
  const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: `wr-api-${seq}`, name: `WR API ${seq}` }).returning();
  const [version] = await db
    .insert(schema.specVersions)
    .values({ apiId: api.id, source: 'openapi', contentHash: `wr-${seq}`, parseStatus: 'parsed' })
    .returning();
  const [run] = await db
    .insert(schema.probeRuns)
    .values({ apiId: api.id, specVersionId: version.id, environment: 'sandbox', kind: 'write_lifecycle', status: 'running', triggeredBy: 'owner' })
    .returning();
  return { orgId: org.id, apiId: api.id, specVersionId: version.id, runId: run.id };
}

function resource(over: Partial<CreatedResource> = {}): CreatedResource {
  return {
    entity: 'tag',
    createActionKey: 'id_create_tag',
    deleteActionKey: 'id_delete_tag',
    ref: makeRef(SENTINEL),
    idSource: 'body',
    cleanup: 'deleted_confirmed',
    deleteStatus: 204,
    readbackStatus: 404,
    ...over,
  };
}

function result(resources: CreatedResource[], over: Partial<WriteRunResult> = {}): WriteRunResult {
  const quarantined = resources.filter((r) => r.cleanup !== 'deleted_confirmed').length;
  return {
    families: [
      {
        entity: 'tag',
        createTool: 'create_tag',
        createActionKey: 'id_create_tag',
        skipped: null,
        steps: { create: 201, read: 200, update: 200, readAfterUpdate: 200, delete: 204, readAfterDelete: 404 },
        idSource: 'body',
        convergence: 'immediate',
        pollCount: 0,
        schemaValid: true,
        unknownFieldCount: 0,
        serverGeneratedFieldCount: 1,
        updateReflected: true,
        useAfterFree: 'gone_404',
        cleanup: resources[0]?.cleanup ?? 'not_created',
        requests: 6,
      },
    ],
    resources,
    evidence: [
      {
        kind: 'probe.write_lifecycle',
        source: 'probe',
        actionId: 'id_create_tag',
        payload: {
          actionId: 'id_create_tag',
          entity: 'tag',
          runId: 'r',
          steps: { create: 201, read: 200, update: 200, readAfterUpdate: 200, delete: 204, readAfterDelete: 404 },
          idSource: 'body',
          convergence: 'immediate',
          pollCount: 0,
          schemaValid: true,
          unknownFieldCount: 0,
          serverGeneratedFieldCount: 1,
          updateReflected: true,
          useAfterFree: 'gone_404',
          cleanup: resources[0]?.cleanup ?? 'not_created',
        },
      },
    ],
    requestsMade: 6,
    effectsUsed: 3,
    created: resources.length,
    deletedConfirmed: resources.length - quarantined,
    quarantined,
    aborted: null,
    outcome: 'completed',
    contractsRehearsed: quarantined ? [] : ['create_tag'],
    ...over,
  };
}

async function persist(ids: Awaited<ReturnType<typeof seed>>, res: WriteRunResult) {
  const built = await buildWriteRunStatements(db, {
    runId: ids.runId,
    apiId: ids.apiId,
    orgId: ids.orgId,
    specVersionId: ids.specVersionId,
    environment: 'sandbox',
    credentialId: null,
    result: res,
    budgetLimit: 30,
    effectBudget: 6,
  });
  for (const stmt of built.statements) await stmt;
  return built.applied;
}

function declaredTables() {
  return Object.entries(schema).filter(([, value]) => value && typeof value === 'object' && Symbol.for('drizzle:Name') in value);
}

async function dumpEntireDatabase(): Promise<string> {
  const dump: Record<string, unknown> = {};
  for (const [name, table] of declaredTables()) {
    try {
      dump[name] = await db.select().from(table as never);
    } catch {
      // Not selectable — nothing to scan.
    }
  }
  return JSON.stringify(dump);
}

describe('a clean run', () => {
  it('lands in completed_clean with its counts', async () => {
    const ids = await seed();
    const applied = await persist(ids, result([resource()]));
    expect(applied.status).toBe('completed_clean');
    const [run] = await db.select().from(schema.probeRuns).where(eq(schema.probeRuns.id, ids.runId));
    expect(run).toMatchObject({ status: 'completed_clean', familiesPlanned: 1, familiesExecuted: 1, requestsMade: 6, effectsUsed: 3, createdCount: 1, deletedConfirmedCount: 1, quarantinedCount: 0, budgetLimit: 30, effectBudget: 6 });
    expect(run.completedAt).not.toBeNull();
  });

  it('keeps only the hash of a confirmed-deleted fixture — the sealed columns are NULL', async () => {
    const ids = await seed();
    await persist(ids, result([resource()]));
    const [row] = await db.select().from(schema.probeResources).where(eq(schema.probeResources.runId, ids.runId));
    expect(row.cleanupStatus).toBe('deleted_confirmed');
    expect(row.resourceIdCiphertext).toBeNull();
    expect(row.resourceIdWrappedDek).toBeNull();
    expect(row.deletedAt).not.toBeNull();
    expect(row.resourceIdHash).toBe(credentialFingerprint(SENTINEL, resourceSealContext(ids.orgId, ids.apiId)));
  });

  it('records the cleanup attempt and marks the contract tested', async () => {
    const ids = await seed();
    await persist(ids, result([resource()]));
    const attempts = await db.select().from(schema.probeCleanupAttempts).where(eq(schema.probeCleanupAttempts.runId, ids.runId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ deleteStatus: 204, readbackStatus: 404, result: 'deleted_confirmed' });
    const contracts = await loadCleanupContracts(db, ids.apiId, 'sandbox');
    expect(contracts.get('create_tag')).toBe(true);
    const [row] = await db.select().from(schema.cleanupContracts).where(eq(schema.cleanupContracts.apiId, ids.apiId));
    expect(row).toMatchObject({ operation: 'create_tag', mechanism: 'inverse_operation', testedRunId: ids.runId });
  });

  it('files the evidence under the sandbox environment', async () => {
    const ids = await seed();
    await persist(ids, result([resource()]));
    const facts = await db.select().from(schema.evidenceFacts).where(and(eq(schema.evidenceFacts.apiId, ids.apiId), eq(schema.evidenceFacts.kind, 'probe.write_lifecycle')));
    expect(facts).toHaveLength(1);
    expect(facts[0].environment).toBe('sandbox');
  });

  it('leaves the identifier nowhere in the database', async () => {
    const ids = await seed();
    await persist(ids, result([resource()]));
    expect(await dumpEntireDatabase()).not.toContain('SENTINEL');
  });
});

describe('a run that left something behind', () => {
  it('lands in completed_with_quarantined_resources and seals the id so a later run can remove it', async () => {
    const ids = await seed();
    const applied = await persist(ids, result([resource({ cleanup: 'deleted_unconfirmed', readbackStatus: 200 })]));
    expect(applied.status).toBe('completed_with_quarantined_resources');
    const [row] = await db.select().from(schema.probeResources).where(eq(schema.probeResources.runId, ids.runId));
    expect(row.cleanupStatus).toBe('deleted_unconfirmed');
    expect(row.resourceIdCiphertext).not.toBeNull();
    expect(row.deletedAt).toBeNull();
    const opened = openCredential(
      {
        scheme: 'aesgcm-hkdf-v1',
        ciphertext: row.resourceIdCiphertext!,
        iv: row.resourceIdIv!,
        authTag: row.resourceIdAuthTag!,
        wrappedDek: row.resourceIdWrappedDek!,
        keyVersion: row.resourceIdKeyVersion!,
      },
      resourceSealContext(ids.orgId, ids.apiId),
    );
    expect(opened).toBe(SENTINEL);
    // Sealed, not stored: the plaintext is still nowhere.
    expect(await dumpEntireDatabase()).not.toContain('SENTINEL');
  });

  it('a fixture the runner could not identify has no ciphertext and is quarantined', async () => {
    const ids = await seed();
    await persist(ids, result([resource({ ref: null, idSource: 'unavailable', cleanup: 'quarantined', deleteStatus: null, readbackStatus: null })]));
    const [row] = await db.select().from(schema.probeResources).where(eq(schema.probeResources.runId, ids.runId));
    expect(row.cleanupStatus).toBe('quarantined');
    expect(row.resourceIdCiphertext).toBeNull();
    expect(row.resourceIdHash).toMatch(/^unavailable:/);
    const attempts = await db.select().from(schema.probeCleanupAttempts).where(eq(schema.probeCleanupAttempts.runId, ids.runId));
    expect(attempts).toHaveLength(0);
  });

  it('does not mark the contract tested', async () => {
    const ids = await seed();
    await persist(ids, result([resource({ cleanup: 'delete_failed', deleteStatus: 500, readbackStatus: null })]));
    expect((await loadCleanupContracts(db, ids.apiId, 'sandbox')).size).toBe(0);
  });

  it('counts unresolved fixtures per entity for the next run’s leak cap', async () => {
    const ids = await seed();
    await persist(ids, result([resource({ cleanup: 'delete_failed', deleteStatus: 500 }), resource({ cleanup: 'deleted_confirmed' }), resource({ entity: 'label', cleanup: 'quarantined', ref: null })]));
    const live = await liveObjectsByEntity(db, ids.apiId, 'sandbox');
    expect(live.get('tag')).toBe(1);
    expect(live.get('label')).toBe(1);
    expect(await liveObjectsByEntity(db, ids.apiId, 'production')).toEqual(new Map());
  });

  it('an aborted run is canceled, with the reason', async () => {
    const ids = await seed();
    const applied = await persist(ids, result([], { outcome: 'canceled', aborted: 'rate_limited', created: 0, deletedConfirmed: 0, quarantined: 0, contractsRehearsed: [] }));
    expect(applied.status).toBe('canceled_clean');
    const [run] = await db.select().from(schema.probeRuns).where(eq(schema.probeRuns.id, ids.runId));
    expect(run.abortedReason).toBe('rate_limited');
  });
});
