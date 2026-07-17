import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { getOrCreateSystemOrg, SYSTEM_ORG_SLUG } from '../db/seedSystemOrg';
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
  const actionsList = overrides.actions ?? [action()];
  return {
    id: 'ephemeral1',
    name: 'Seeded API',
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

async function runSequentially(statements: Awaited<ReturnType<typeof buildPersistStatements>>['statements']) {
  for (const stmt of statements) await stmt;
}

// seedUnclaimedApi() itself calls the real persistApi()/getDb(), which need
// db.batch() (Neon-only, see persist.ts's header comment) and a live
// DATABASE_URL — neither works against the pglite test harness. This
// exercises the same DB-writing path it wires together (system org +
// buildPersistStatements with claimStatus: 'unclaimed'), skipping only
// runImport()'s network fetch in favor of a fixture record.
describe('seedUnclaimedApi DB-writing behavior', () => {
  it('persists an apis row owned by the system org with claimStatus "unclaimed"', async () => {
    const systemOrg = await getOrCreateSystemOrg(db);
    expect(systemOrg.slug).toBe(SYSTEM_ORG_SLUG);

    const rec = record();
    const result = await buildPersistStatements(db, {
      orgId: systemOrg.id,
      record: rec,
      rawText: '{"openapi":"3.0.0"}',
      claimStatus: 'unclaimed',
    });
    await runSequentially(result.statements);

    const [api] = await db.select().from(schema.apis).where(eq(schema.apis.id, result.apiId));
    expect(api.claimStatus).toBe('unclaimed');
    expect(api.orgId).toBe(systemOrg.id);
  });
});
