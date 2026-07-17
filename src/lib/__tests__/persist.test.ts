import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import type { Action, ImportRecord } from '../ir';
import { buildPersistStatements } from '../persist';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    name: 'get_thing',
    description: 'Get a thing',
    method: 'GET',
    path: '/things/{id}',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'none',
    safety: 'read',
    examples: [],
    ...overrides,
  };
}

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  const actionsList = overrides.actions ?? [action(), action({ id: 'a2', name: 'delete_thing', safety: 'destructive', method: 'DELETE' })];
  return {
    id: 'ephemeral1',
    name: 'Test API',
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'bearer',
    actions: actionsList,
    counts: {
      total: actionsList.length,
      read: actionsList.filter((a) => a.safety === 'read').length,
      write: actionsList.filter((a) => a.safety === 'write').length,
      destructive: actionsList.filter((a) => a.safety === 'destructive').length,
    },
    createdAt: 0,
    expiresAt: 0,
    ...overrides,
  };
}

async function makeOrg(suffix: string) {
  const [org] = await db.insert(schema.orgs).values({ name: `Org ${suffix}`, slug: `persist-org-${suffix}` }).returning();
  return org;
}

// buildPersistStatements() returns Drizzle query builders, which are
// thenables usable standalone — running them sequentially here (instead of
// db.batch(), which only the real Neon driver implements) still lets us
// verify every row lands with the right shape and linkage.
async function runSequentially(statements: Awaited<ReturnType<typeof buildPersistStatements>>['statements']) {
  for (const stmt of statements) await stmt;
}

describe('buildPersistStatements', () => {
  it('persists an api, its spec version, actions, evidence facts, and a linked score preview', async () => {
    const org = await makeOrg('a');
    const rawText = '{"openapi":"3.0.0"}';
    const rec = record();

    const result = await buildPersistStatements(db, { orgId: org.id, record: rec, rawText });
    await runSequentially(result.statements);

    const [api] = await db.select().from(schema.apis).where(eq(schema.apis.id, result.apiId));
    expect(api.slug).toBe(result.slug);
    expect(api.orgId).toBe(org.id);
    expect(api.name).toBe('Test API');
    expect(api.baseUrls).toEqual(['https://api.example.com']);
    expect(api.dominantAuth).toBe('bearer');
    expect(api.currentSpecVersionId).toBe(result.specVersionId);

    const [specVersion] = await db.select().from(schema.specVersions).where(eq(schema.specVersions.id, result.specVersionId));
    expect(specVersion.contentHash).toBe(createHash('sha256').update(rawText).digest('hex'));
    expect(specVersion.actionCount).toBe(2);

    const rows = await db.select().from(schema.actions).where(eq(schema.actions.apiId, result.apiId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(['delete_thing', 'get_thing']);

    const facts = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, result.apiId));
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.kind.startsWith('parser.'))).toBe(true);

    const [preview] = await db.select().from(schema.scorePreviews).where(eq(schema.scorePreviews.apiId, result.apiId));
    expect(preview.specVersionId).toBe(result.specVersionId);
    const explanation = preview.explanation as Array<{ factId: string; message: string }>;
    expect(explanation).toHaveLength(facts.length);
    const factIds = new Set(facts.map((f) => f.id));
    for (const e of explanation) expect(factIds.has(e.factId)).toBe(true);
  });

  it('allocates distinct slugs across separate persist calls for the same name', async () => {
    const org = await makeOrg('b');
    const rec = record({ name: 'Duplicate Name' });

    const first = await buildPersistStatements(db, { orgId: org.id, record: rec, rawText: 'a' });
    await runSequentially(first.statements);
    const second = await buildPersistStatements(db, { orgId: org.id, record: rec, rawText: 'b' });
    await runSequentially(second.statements);

    expect(first.slug).not.toBe(second.slug);
    expect(second.slug).toBe(`${first.slug}-2`);
  });

  it('handles a record with zero actions without writing any action rows', async () => {
    const org = await makeOrg('c');
    const rec = record({ actions: [], counts: { total: 0, read: 0, write: 0, destructive: 0 } });

    const result = await buildPersistStatements(db, { orgId: org.id, record: rec, rawText: '{}' });
    await runSequentially(result.statements);

    const rows = await db.select().from(schema.actions).where(eq(schema.actions.apiId, result.apiId));
    expect(rows).toHaveLength(0);
  });

  it('records createdBy on the api row when provided', async () => {
    const org = await makeOrg('d');
    const [user] = await db.insert(schema.users).values({ clerkUserId: 'clerk_persist', email: 'p@example.com' }).returning();

    const result = await buildPersistStatements(db, { orgId: org.id, createdBy: user.id, record: record(), rawText: 'x' });
    await runSequentially(result.statements);

    const [api] = await db.select().from(schema.apis).where(and(eq(schema.apis.id, result.apiId), eq(schema.apis.createdBy, user.id)));
    expect(api).toBeDefined();
  });

  it('persists responseSchema/errorSchema onto the actions row when present', async () => {
    const org = await makeOrg('e');
    const rec = record({
      actions: [
        action({
          responseSchema: { type: 'object', properties: { id: { type: 'string' } } },
          errorSchema: { type: 'object', properties: { error: { type: 'string' } } },
        }),
      ],
      counts: { total: 1, read: 1, write: 0, destructive: 0 },
    });

    const result = await buildPersistStatements(db, { orgId: org.id, record: rec, rawText: 'schemas' });
    await runSequentially(result.statements);

    const [row] = await db.select().from(schema.actions).where(eq(schema.actions.apiId, result.apiId));
    expect(row.responseSchemas).toEqual({ type: 'object', properties: { id: { type: 'string' } } });
    expect(row.errorSchemas).toEqual({ type: 'object', properties: { error: { type: 'string' } } });
  });

  it('leaves responseSchemas/errorSchemas null when the action carries none', async () => {
    const org = await makeOrg('f');
    const result = await buildPersistStatements(db, { orgId: org.id, record: record({ actions: [action()], counts: { total: 1, read: 1, write: 0, destructive: 0 } }), rawText: 'noschemas' });
    await runSequentially(result.statements);

    const [row] = await db.select().from(schema.actions).where(eq(schema.actions.apiId, result.apiId));
    expect(row.responseSchemas).toBeNull();
    expect(row.errorSchemas).toBeNull();
  });

  it('defaults claimStatus to "claimed" when not specified', async () => {
    const org = await makeOrg('g');
    const result = await buildPersistStatements(db, { orgId: org.id, record: record(), rawText: 'default-claim' });
    await runSequentially(result.statements);

    const [api] = await db.select().from(schema.apis).where(eq(schema.apis.id, result.apiId));
    expect(api.claimStatus).toBe('claimed');
  });

  it('honors an explicit claimStatus of "unclaimed"', async () => {
    const org = await makeOrg('h');
    const result = await buildPersistStatements(db, { orgId: org.id, record: record(), rawText: 'unclaimed', claimStatus: 'unclaimed' });
    await runSequentially(result.statements);

    const [api] = await db.select().from(schema.apis).where(eq(schema.apis.id, result.apiId));
    expect(api.claimStatus).toBe('unclaimed');
  });
});
