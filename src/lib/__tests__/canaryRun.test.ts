import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCanaryStatements } from '../canaryRun';
import { inferShape, mergeShapes, type ObservedShape, type OperationSnapshot } from '../changes/observation';
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
    name: 'get_pet',
    description: 'Get a pet',
    method: 'GET',
    path: '/pets/{id}',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'none',
    safety: 'read',
    examples: [],
    responseSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
    ...overrides,
  };
}

function record(actions: Action[]): ImportRecord {
  return {
    id: 'cr',
    name: 'Canary Run API',
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'none',
    actions,
    counts: { total: actions.length, read: actions.length, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
  };
}

let seq = 0;
async function seedApi(actions: Action[] = [action()]) {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `CR Org ${seq}`, slug: `cr-org-${seq}` }).returning();
  const built = await buildPersistStatements(db, { orgId: org.id, record: record(actions), rawText: `{"cr":${seq}}` });
  for (const statement of built.statements) await statement;
  return built;
}

async function run(statements: unknown[]) {
  for (const statement of statements) await statement;
}

function seen(body: unknown, n: number): ObservedShape {
  return mergeShapes(Array.from({ length: n }, () => inferShape(body)));
}

function snapshot(shape: ObservedShape, sampleCount = 3, overrides: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    actionKey: 'a1',
    tool: 'get_pet',
    method: 'GET',
    path: '/pets/{id}',
    sampleCount,
    statusCounts: { '200': sampleCount },
    shape,
    latencyP50Ms: 12,
    latencyMaxMs: 20,
    ...overrides,
  };
}

function inputFor(seeded: Awaited<ReturnType<typeof seedApi>>, snapshots: OperationSnapshot[], actions: Action[] = [action()]) {
  return {
    apiId: seeded.apiId,
    specVersionId: seeded.specVersionId,
    snapshots,
    actionsByKey: new Map(actions.map((a) => [a.id, a])),
  };
}

async function observations(apiId: string) {
  return db.select().from(schema.operationObservations).where(eq(schema.operationObservations.apiId, apiId));
}

async function changeRows(apiId: string) {
  return db.select().from(schema.apiChanges).where(eq(schema.apiChanges.apiId, apiId));
}

describe('buildCanaryStatements', () => {
  it('stores the first snapshot and reports nothing changed, having nothing to compare to', async () => {
    const seeded = await seedApi();
    const result = await buildCanaryStatements(db, inputFor(seeded, [snapshot(seen({ id: 'x', name: 'n' }, 3))]));
    await run(result.statements);

    expect(result.comparedAgainstPrevious).toBe(0);
    expect(result.changes).toEqual([]);

    const stored = await observations(seeded.apiId);
    expect(stored).toHaveLength(1);
    expect(stored[0].sampleCount).toBe(3);
    expect(stored[0].actionId).toBeTruthy(); // linked to the concrete action row
    // The safety property, asserted where it actually lands: no value reaches
    // the column, only paths, type names, and counts.
    expect(JSON.stringify(stored[0].shape)).not.toContain('"x"');
  });

  it('compares the second run against the first and writes what changed', async () => {
    const seeded = await seedApi();
    await run((await buildCanaryStatements(db, inputFor(seeded, [snapshot(seen({ id: 'x', name: 'n' }, 3))]))).statements);

    const second = await buildCanaryStatements(db, inputFor(seeded, [snapshot(seen({ id: 'x' }, 3))]));
    await run(second.statements);

    expect(second.comparedAgainstPrevious).toBe(1);
    expect(second.changes).toHaveLength(1);

    const rows = await changeRows(seeded.apiId);
    const removed = rows.find((r) => r.kind === 'field.removed')!;
    expect(removed).toMatchObject({ severity: 'breaking', source: 'probe', fieldPath: 'response.name', location: 'response' });
    // A behavioural finding belongs to no spec diff — nothing moved between
    // two documents — so `from` is null and `to` records what was being served.
    expect(removed.fromSpecVersionId).toBeNull();
    expect(removed.toSpecVersionId).toBe(seeded.specVersionId);
  });

  it('compares against the most recent snapshot, not the oldest', async () => {
    const seeded = await seedApi();
    await run((await buildCanaryStatements(db, inputFor(seeded, [snapshot(seen({ id: 'x', gone: 1 }, 3))]))).statements);
    await run(
      (await buildCanaryStatements(db, inputFor(seeded, [snapshot(seen({ id: 'x' }, 3))]))).statements,
    );

    // Third run matches the second, so nothing new should be reported even
    // though it differs from the first.
    const third = await buildCanaryStatements(db, inputFor(seeded, [snapshot(seen({ id: 'x' }, 3))]));
    expect(third.changes).toEqual([]);
    expect(third.comparedAgainstPrevious).toBe(1);
  });

  // The classic docs-drift case: the API returns something its spec never
  // mentions, so the operation is marked drifted.
  it('marks an operation drifted when its live shape disagrees with the spec', async () => {
    const seeded = await seedApi();
    const result = await buildCanaryStatements(
      db,
      inputFor(seeded, [snapshot(seen({ id: 'x', name: 'n', undocumented: true }, 3))]),
    );
    await run(result.statements);

    expect(result.driftedActionKeys).toEqual(['a1']);
    const [row] = await db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.specVersionId, seeded.specVersionId));
    expect(row.operationStability).toBe('drifted');
  });

  it('leaves an operation documented when live and spec agree', async () => {
    const seeded = await seedApi();
    const result = await buildCanaryStatements(db, inputFor(seeded, [snapshot(seen({ id: 'x', name: 'n' }, 3))]));
    await run(result.statements);

    expect(result.driftedActionKeys).toEqual([]);
    const [row] = await db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.specVersionId, seeded.specVersionId));
    expect(row.operationStability).toBe('documented');
  });

  it('writes no statements at all for an empty run', async () => {
    const seeded = await seedApi();
    const result = await buildCanaryStatements(db, inputFor(seeded, []));
    expect(result.statements).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  it('stores a snapshot per operation and keeps their histories separate', async () => {
    const two = [action(), action({ id: 'a2', name: 'list_pets', path: '/pets' })];
    const seeded = await seedApi(two);
    const snapshots = [
      snapshot(seen({ id: 'x', name: 'n' }, 3)),
      snapshot(seen({ total: 1 }, 3), 3, { actionKey: 'a2', tool: 'list_pets', path: '/pets' }),
    ];
    await run((await buildCanaryStatements(db, inputFor(seeded, snapshots, two))).statements);

    // Only the first operation changes on the next run.
    const second = await buildCanaryStatements(
      db,
      inputFor(seeded, [snapshot(seen({ id: 'x' }, 3)), snapshots[1]], two),
    );
    expect(second.comparedAgainstPrevious).toBe(2);
    expect(second.changes.map((c) => c.tool)).toEqual(['get_pet']);
  });
});
