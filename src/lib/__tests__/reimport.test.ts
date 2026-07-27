// Re-import: a new spec version for an API that already exists — the write
// path CI sync and scheduled re-verification depend on.
//
// Same harness convention as persist.test.ts: buildReimportStatements() returns
// Drizzle query builders, which are thenables usable standalone, so running
// them sequentially against pglite verifies every row lands correctly without
// needing neon-http's .batch().

import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import type { Action, ImportRecord } from '../ir';
import { buildPersistStatements, buildReimportStatements } from '../persist';

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
  const actionsList = overrides.actions ?? [action()];
  return {
    id: 'ephemeral1',
    name: 'Reimport API',
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

type Statements = Awaited<ReturnType<typeof buildReimportStatements>>['statements'];

async function runSequentially(statements: Statements) {
  for (const statement of statements) await statement;
}

let seq = 0;
// Seeds a persistent API through the real first-import path, so re-import runs
// against exactly the rows production would have.
async function seedApi(rawText: string, rec: ImportRecord = record()) {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `Org ${seq}`, slug: `reimport-org-${seq}` }).returning();
  const built = await buildPersistStatements(db, { orgId: org.id, record: rec, rawText });
  await runSequentially(built.statements as Statements);
  return { orgId: org.id, apiId: built.apiId, slug: built.slug, specVersionId: built.specVersionId };
}

async function currentVersion(apiId: string) {
  const [row] = await db
    .select({ currentSpecVersionId: schema.apis.currentSpecVersionId })
    .from(schema.apis)
    .where(eq(schema.apis.id, apiId));
  return row.currentSpecVersionId;
}

async function versionCount(apiId: string) {
  const rows = await db.select().from(schema.specVersions).where(eq(schema.specVersions.apiId, apiId));
  return rows.length;
}

describe('buildReimportStatements', () => {
  it('reports unchanged and emits no statements for byte-identical content', async () => {
    const raw = '{"openapi":"3.0.0","x":1}';
    const { apiId, specVersionId } = await seedApi(raw);

    const result = await buildReimportStatements(db, { apiId, record: record(), rawText: raw });

    expect(result.status).toBe('unchanged');
    expect(result.specVersionId).toBe(specVersionId);
    // The point: a CI job running on every push costs nothing when the spec
    // hasn't moved.
    expect(result.statements).toHaveLength(0);
  });

  it('records a new version and repoints the API at it when content changes', async () => {
    const { apiId, specVersionId: firstVersion } = await seedApi('{"openapi":"3.0.0","x":1}');

    const updated = record({ actions: [action(), action({ id: 'a2', name: 'list_things', path: '/things' })] });
    const result = await buildReimportStatements(db, { apiId, record: updated, rawText: '{"openapi":"3.0.0","x":2}' });
    await runSequentially(result.statements as Statements);

    expect(result.status).toBe('updated');
    expect(result.specVersionId).not.toBe(firstVersion);
    expect(await currentVersion(apiId)).toBe(result.specVersionId);
    expect(await versionCount(apiId)).toBe(2);
  });

  it('writes the action rows for the new version only', async () => {
    const { apiId } = await seedApi('{"v":1}');
    const updated = record({ actions: [action({ id: 'b1', name: 'renamed_thing' })] });
    const result = await buildReimportStatements(db, { apiId, record: updated, rawText: '{"v":2}' });
    await runSequentially(result.statements as Statements);

    const newRows = await db
      .select()
      .from(schema.actions)
      .where(and(eq(schema.actions.apiId, apiId), eq(schema.actions.specVersionId, result.specVersionId)));
    expect(newRows.map((r) => r.name)).toEqual(['renamed_thing']);

    // Old version's rows survive, so a historical score stays explainable.
    const allRows = await db.select().from(schema.actions).where(eq(schema.actions.apiId, apiId));
    expect(allRows.length).toBe(2);
  });

  it('persists and restores OAuth scopes through a re-import round trip', async () => {
    const { apiId } = await seedApi('{"v":1}');
    const scoped = record({ actions: [action({ id: 'c1', name: 'scoped_action', auth: 'oauth2', scopes: ['write:orders'] })] });
    const result = await buildReimportStatements(db, { apiId, record: scoped, rawText: '{"v":2}' });
    await runSequentially(result.statements as Statements);

    const [row] = await db
      .select()
      .from(schema.actions)
      .where(and(eq(schema.actions.apiId, apiId), eq(schema.actions.specVersionId, result.specVersionId)));
    expect(row.scopes).toEqual(['write:orders']);
  });

  it('stores no scopes for an action that declares none', async () => {
    const { apiId } = await seedApi('{"v":1}');
    const unscoped = record({ actions: [action({ id: 'd1', name: 'plain_action' })] });
    const result = await buildReimportStatements(db, { apiId, record: unscoped, rawText: '{"v":2}' });
    await runSequentially(result.statements as Statements);

    const [row] = await db
      .select()
      .from(schema.actions)
      .where(and(eq(schema.actions.apiId, apiId), eq(schema.actions.specVersionId, result.specVersionId)));
    expect(row.scopes).toBeNull();
  });

  it('replaces the score preview rather than accumulating rows', async () => {
    const { apiId } = await seedApi('{"v":1}');
    const result = await buildReimportStatements(db, { apiId, record: record(), rawText: '{"v":2}' });
    await runSequentially(result.statements as Statements);

    const previews = await db.select().from(schema.scorePreviews).where(eq(schema.scorePreviews.apiId, apiId));
    expect(previews).toHaveLength(1);
    expect(previews[0].specVersionId).toBe(result.specVersionId);
  });

  it('appends evidence facts for the new version, keeping the old ones', async () => {
    const { apiId, specVersionId: firstVersion } = await seedApi('{"v":1}');
    const result = await buildReimportStatements(db, { apiId, record: record(), rawText: '{"v":2}' });
    await runSequentially(result.statements as Statements);

    const facts = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, apiId));
    const versions = new Set(facts.map((f) => f.specVersionId));
    expect(versions.has(firstVersion)).toBe(true);
    expect(versions.has(result.specVersionId)).toBe(true);
  });

  it('carries forward base urls and auth that moved between versions', async () => {
    const { apiId } = await seedApi('{"v":1}');
    const moved = record({ baseUrls: ['https://api-v2.example.com'], auth: 'apiKey', authIn: { in: 'header', name: 'X-Key' } });
    const result = await buildReimportStatements(db, { apiId, record: moved, rawText: '{"v":2}' });
    await runSequentially(result.statements as Statements);

    const [api] = await db.select().from(schema.apis).where(eq(schema.apis.id, apiId));
    expect(api.baseUrls).toEqual(['https://api-v2.example.com']);
    expect(api.dominantAuth).toBe('apiKey');
    expect(api.authIn).toEqual({ in: 'header', name: 'X-Key' });
  });

  it('treats a return to earlier content as a revert, without duplicating the version', async () => {
    const first = '{"v":1}';
    const { apiId, specVersionId: firstVersion } = await seedApi(first);

    const second = await buildReimportStatements(db, { apiId, record: record(), rawText: '{"v":2}' });
    await runSequentially(second.statements as Statements);
    expect(await currentVersion(apiId)).toBe(second.specVersionId);

    const back = await buildReimportStatements(db, { apiId, record: record(), rawText: first });
    await runSequentially(back.statements as Statements);

    expect(back.status).toBe('reverted');
    expect(back.specVersionId).toBe(firstVersion);
    expect(await currentVersion(apiId)).toBe(firstVersion);
    // No third row: the unique (api_id, content_hash) constraint is the point.
    expect(await versionCount(apiId)).toBe(2);
  });

  it('hashes the raw bytes, so whitespace counts as a change', async () => {
    const { apiId } = await seedApi('{"v":1}');
    const spaced = await buildReimportStatements(db, { apiId, record: record(), rawText: '{"v": 1}' });
    expect(spaced.status).toBe('updated');
    expect(spaced.contentHash).toHaveLength(64);
  });

  it('scopes version lookup per API, so two APIs can share spec content', async () => {
    const raw = '{"shared":true}';
    const a = await seedApi(raw);
    const b = await seedApi(raw);
    expect(a.apiId).not.toBe(b.apiId);

    // Identical content, different API — each is unchanged against its own row.
    expect((await buildReimportStatements(db, { apiId: a.apiId, record: record(), rawText: raw })).status).toBe('unchanged');
    expect((await buildReimportStatements(db, { apiId: b.apiId, record: record(), rawText: raw })).status).toBe('unchanged');
  });

  it('handles a spec that parsed to zero actions without emitting an empty insert', async () => {
    const { apiId } = await seedApi('{"v":1}');
    const empty = record({ actions: [], counts: { total: 0, read: 0, write: 0, destructive: 0 } });
    const result = await buildReimportStatements(db, { apiId, record: empty, rawText: '{"v":"empty"}' });
    await runSequentially(result.statements as Statements);

    const rows = await db
      .select()
      .from(schema.actions)
      .where(and(eq(schema.actions.apiId, apiId), eq(schema.actions.specVersionId, result.specVersionId)));
    expect(rows).toHaveLength(0);
    expect(await currentVersion(apiId)).toBe(result.specVersionId);
  });

  it('records the action count on the version row', async () => {
    const { apiId } = await seedApi('{"v":1}');
    const three = record({
      actions: [action(), action({ id: 'a2', name: 'b' }), action({ id: 'a3', name: 'c' })],
    });
    const result = await buildReimportStatements(db, { apiId, record: three, rawText: '{"v":3}' });
    await runSequentially(result.statements as Statements);

    const [version] = await db
      .select()
      .from(schema.specVersions)
      .where(eq(schema.specVersions.id, result.specVersionId));
    expect(version.actionCount).toBe(3);
    expect(version.parseStatus).toBe('parsed');
  });

  // End-to-end confirmation on the reimport path specifically: evidence is
  // append-only, so each version needs its OWN recomputed lineage rather than
  // reusing the previous version's.
  it('materializes field-lineage evidence scoped to the new spec version', async () => {
    const { apiId } = await seedApi('{"v":1}');
    const linked = record({
      actions: [
        action({
          id: 'rl1',
          name: 'list_customers',
          method: 'GET',
          path: '/customers',
          responseSchema: {
            type: 'array',
            items: { type: 'object', properties: { customerId: { type: 'string', format: 'uuid' } } },
          },
        }),
        action({
          id: 'rl2',
          name: 'create_order',
          method: 'POST',
          path: '/orders',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            required: ['body'],
            properties: {
              body: {
                type: 'object',
                required: ['customerId'],
                properties: { customerId: { type: 'string', format: 'uuid' } },
                'x-spotcheck-in': 'body',
              },
            },
          },
        }),
      ],
    });
    const result = await buildReimportStatements(db, { apiId, record: linked, rawText: '{"v":2}' });
    await runSequentially(result.statements as Statements);

    const rows = await db
      .select()
      .from(schema.evidenceFacts)
      .where(and(eq(schema.evidenceFacts.apiId, apiId), eq(schema.evidenceFacts.kind, 'graph.field_lineage')));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.specVersionId === result.specVersionId)).toBe(true);
  });
});
