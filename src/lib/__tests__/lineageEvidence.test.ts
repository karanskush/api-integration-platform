import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { buildLineageEvidenceStatements } from '../lineageEvidence';
import type { Action, ImportRecord } from '../ir';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

function action(o: Partial<Action> & { name: string; method: string; path: string }): Action {
  return {
    id: `id_${o.name}`,
    description: 'd',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: 'read',
    examples: [],
    ...o,
  } as Action;
}

function param(where: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { 'x-spotcheck-in': where, ...extra };
}

// One clear, high-confidence edge: list_customers.response[].id -> the
// create_order body's customerId, via the foreign-key + resource-affinity
// signals the lineage engine already tests on their own.
function recordWithOneEdge(): ImportRecord {
  const actions = [
    action({
      name: 'list_customers',
      method: 'GET',
      path: '/customers',
      responseSchema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    }),
    action({
      name: 'create_order',
      method: 'POST',
      path: '/orders',
      safety: 'write',
      paramsSchema: {
        type: 'object',
        required: ['body'],
        properties: {
          body: param('body', {
            type: 'object',
            required: ['customerId'],
            properties: { customerId: { type: 'string', format: 'uuid' } },
          }),
        },
      },
    }),
  ];
  return {
    id: 'r',
    name: 'R',
    source: 'openapi',
    baseUrls: [],
    auth: 'bearer',
    actions,
    counts: { total: 2, read: 1, write: 1, destructive: 0 },
    createdAt: 1,
    expiresAt: 9,
  };
}

let seq = 0;
async function seedApiRow() {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `LE Org ${seq}`, slug: `le-org-${seq}` }).returning();
  const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: `le-api-${seq}`, name: `LE API ${seq}` }).returning();
  const [version] = await db
    .insert(schema.specVersions)
    .values({ apiId: api.id, source: 'openapi', contentHash: `hash-${seq}`, parseStatus: 'parsed' })
    .returning();
  return { apiId: api.id, specVersionId: version.id };
}

async function runStatements(statements: ReturnType<typeof buildLineageEvidenceStatements>) {
  for (const s of statements) await s;
}

describe('buildLineageEvidenceStatements', () => {
  it('emits no statements when the API has no lineage edges', async () => {
    const { apiId, specVersionId } = await seedApiRow();
    const bare: ImportRecord = {
      id: 'bare',
      name: 'Bare',
      source: 'openapi',
      baseUrls: [],
      auth: 'none',
      actions: [action({ name: 'ping', method: 'GET', path: '/ping' })],
      counts: { total: 1, read: 1, write: 0, destructive: 0 },
      createdAt: 1,
      expiresAt: 9,
    };
    expect(buildLineageEvidenceStatements(db, { apiId, specVersionId, record: bare })).toEqual([]);
  });

  it('writes one evidence_facts row per edge, kinded and scoped correctly', async () => {
    const { apiId, specVersionId } = await seedApiRow();
    const statements = buildLineageEvidenceStatements(db, { apiId, specVersionId, record: recordWithOneEdge() });
    expect(statements.length).toBeGreaterThan(0);
    await runStatements(statements);

    const rows = await db
      .select()
      .from(schema.evidenceFacts)
      .where(eq(schema.evidenceFacts.apiId, apiId));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.kind).toBe('graph.field_lineage');
      expect(row.source).toBe('parser');
      expect(row.specVersionId).toBe(specVersionId);
      // A lineage edge spans two actions, so it has no single row for this FK.
      expect(row.actionId).toBeNull();
    }
  });

  it('keys both endpoints by tool name and field path, not a row uuid', async () => {
    const { apiId, specVersionId } = await seedApiRow();
    await runStatements(buildLineageEvidenceStatements(db, { apiId, specVersionId, record: recordWithOneEdge() }));

    const [row] = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, apiId));
    const payload = row.payload as Record<string, unknown>;
    expect(payload.fromTool).toBe('list_customers');
    expect(payload.toTool).toBe('create_order');
    expect(payload.toField).toBe('body.customerId');
    expect(payload.why).toBeInstanceOf(Array);
    expect((payload.why as unknown[]).length).toBeGreaterThan(0);
  });

  it('maps the discrete confidence bucket onto the shared 0..1 scale', async () => {
    const { apiId, specVersionId } = await seedApiRow();
    await runStatements(buildLineageEvidenceStatements(db, { apiId, specVersionId, record: recordWithOneEdge() }));

    const [row] = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, apiId));
    const payload = row.payload as { confidence: string };
    expect(payload.confidence).toBe('high');
    expect(row.confidence).toBeGreaterThan(0.5);
  });

  it('validates against the graph.field_lineage zod schema', async () => {
    const { parseEvidencePayload } = await import('../evidence');
    const { apiId, specVersionId } = await seedApiRow();
    await runStatements(buildLineageEvidenceStatements(db, { apiId, specVersionId, record: recordWithOneEdge() }));

    const [row] = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, apiId));
    expect(parseEvidencePayload('graph.field_lineage', row.payload)).not.toBeNull();
  });

  it('never writes evidence for two unrelated resources sharing a generic field name', async () => {
    const { apiId, specVersionId } = await seedApiRow();
    const record: ImportRecord = {
      id: 'r2',
      name: 'R2',
      source: 'openapi',
      baseUrls: [],
      auth: 'bearer',
      actions: [
        action({
          name: 'get_weather',
          method: 'GET',
          path: '/weather',
          responseSchema: { type: 'object', properties: { status: { type: 'string' } } },
        }),
        action({
          name: 'update_shipment',
          method: 'POST',
          path: '/shipments',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            properties: { body: param('body', { type: 'object', properties: { status: { type: 'string' } } }) },
          },
        }),
      ],
      counts: { total: 2, read: 1, write: 1, destructive: 0 },
      createdAt: 1,
      expiresAt: 9,
    };
    expect(buildLineageEvidenceStatements(db, { apiId, specVersionId, record })).toEqual([]);
  });
});
