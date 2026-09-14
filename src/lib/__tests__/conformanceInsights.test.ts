// The read-side conformance facts reach the advisor, newest per operation,
// each carrying the environment it was observed in.
import { beforeAll, describe, expect, it } from 'vitest';
import { loadAdvisorInsights } from '../advisor/insights';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import type { Action, ImportRecord } from '../ir';
import { buildPersistStatements } from '../persist';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

let seq = 0;
async function seedApi() {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `CF ${seq}`, slug: `cf-${seq}` }).returning();
  const record: ImportRecord = {
    id: 'cf',
    name: `Conformance ${seq}`,
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'none',
    actions: [
      { id: 'a1', name: 'get_pet', description: 'x', method: 'GET', path: '/pets/{id}', paramsSchema: { type: 'object', properties: {} }, auth: 'none', safety: 'read', examples: [] } as Action,
    ],
    counts: { total: 1, read: 1, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
  };
  const built = await buildPersistStatements(db, { orgId: org.id, record, rawText: `{"cf":${seq}}` });
  for (const st of built.statements) await st;
  return built;
}

const fact = (apiId: string, kind: string, payload: unknown, observedAt: Date, environment = 'production') => ({
  apiId,
  kind,
  source: 'probe',
  environment,
  observedAt,
  payload,
});

describe('conformance insights', () => {
  it('loads every conformance kind with its environment', async () => {
    const { apiId, slug } = await seedApi();
    const at = new Date('2026-09-14T10:00:00Z');
    await db.insert(schema.evidenceFacts).values([
      fact(apiId, 'probe.response_conformance', { actionId: 'a1', status: 200, contentTypeObserved: 'application/json', contentTypeMatches: true, schemaValid: false, schemaErrorCount: 1, schemaErrorPaths: ['/name'], discriminating: null, paramSources: ['harvested'] }, at, 'sandbox'),
      fact(apiId, 'probe.negative_partition', { actionId: 'a1', partition: 'unknown_id', field: 'id', status: 404, rejected: true, matchesErrorSchema: null, hasReadableMessage: true }, at, 'sandbox'),
      fact(apiId, 'probe.not_found_identity', { actionId: 'a1', status: 404, identity: 'not_found_404', controlBasis: 'fabricated_like_real', matchesErrorSchema: null, hasReadableMessage: true }, at, 'sandbox'),
      fact(apiId, 'probe.method_support', { actionId: 'a1', path: '/pets/{id}', method: 'OPTIONS', status: 204, allowHeaderPresent: true, allowDeclaredAgreement: 'agrees', undeclaredMethods: [] }, at, 'sandbox'),
      fact(apiId, 'probe.pagination_behavior', { actionId: 'a1', model: 'cursor', start: { status: 200, items: 1 }, continue: { status: 200, advanced: true }, cursorReuse: { status: 200, samePage: true } }, at, 'sandbox'),
    ]);

    const insights = await loadAdvisorInsights(slug, db);
    expect(insights.conformance).toEqual([
      { actionId: 'a1', status: 200, contentTypeMatches: true, schemaValid: false, schemaErrorCount: 1, schemaErrorPaths: ['/name'], discriminating: null, observedAt: at.toISOString(), environment: 'sandbox' },
    ]);
    expect(insights.negativePartitions).toMatchObject([{ actionId: 'a1', partition: 'unknown_id', rejected: true, environment: 'sandbox' }]);
    expect(insights.notFoundIdentity).toMatchObject([{ actionId: 'a1', identity: 'not_found_404', environment: 'sandbox' }]);
    expect(insights.methodSupport).toMatchObject([{ actionId: 'a1', allowDeclaredAgreement: 'agrees', environment: 'sandbox' }]);
    expect(insights.paginationBehavior).toMatchObject([{ actionId: 'a1', model: 'cursor', continue: { advanced: true }, environment: 'sandbox' }]);
  });

  it('keeps the newest conformance row per operation', async () => {
    const { apiId, slug } = await seedApi();
    const base = { actionId: 'a1', status: 200, contentTypeObserved: null, contentTypeMatches: null, schemaErrorCount: 0, schemaErrorPaths: [], discriminating: null, paramSources: [] };
    await db.insert(schema.evidenceFacts).values([
      fact(apiId, 'probe.response_conformance', { ...base, schemaValid: false }, new Date('2026-09-01T00:00:00Z')),
      fact(apiId, 'probe.response_conformance', { ...base, schemaValid: true }, new Date('2026-09-14T00:00:00Z')),
    ]);
    const insights = await loadAdvisorInsights(slug, db);
    expect(insights.conformance).toHaveLength(1);
    expect(insights.conformance[0].schemaValid).toBe(true);
  });

  it('ignores a malformed historical row rather than failing the tool call', async () => {
    const { apiId, slug } = await seedApi();
    await db.insert(schema.evidenceFacts).values([fact(apiId, 'probe.method_support', { garbage: true }, new Date())]);
    const insights = await loadAdvisorInsights(slug, db);
    expect(insights.methodSupport).toEqual([]);
  });
});
