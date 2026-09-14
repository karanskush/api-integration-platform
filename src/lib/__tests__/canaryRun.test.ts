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

// The write path has always stamped `environment`; the read ignored it, so a
// sandbox observation and a production one competed for "newest" on the same
// operation. The loser's shape became the baseline for the winner's next run,
// and the difference between two ENVIRONMENTS was reported as behavioural
// drift on the contract — a false breaking-change claim, which is the one
// thing this canary is built never to produce.
describe('comparison is fenced to one environment', () => {
  // `name` is in the action's responseSchema, so a removal is reportable.
  const wide = () => seen({ id: 'x', name: 'Rex' }, 3);
  const narrow = () => seen({ id: 'x' }, 3);

  it('does not compare a production run against a sandbox observation', async () => {
    const seeded = await seedApi();
    const at = (min: number) => new Date(Date.UTC(2026, 8, 8, 10, min));

    // Production has only ever returned the narrow shape.
    await run(
      (
        await buildCanaryStatements(db, {
          ...inputFor(seeded, [snapshot(narrow())]),
          environment: 'production',
          observedAt: at(0),
        })
      ).statements,
    );

    // A sandbox run lands LATER, so unfenced it is the newest row for this
    // operation and becomes the baseline the next production run is compared
    // against. That ordering is the whole bug.
    await run(
      (
        await buildCanaryStatements(db, {
          ...inputFor(seeded, [snapshot(wide())]),
          environment: 'sandbox',
          observedAt: at(1),
        })
      ).statements,
    );

    const result = await buildCanaryStatements(db, {
      ...inputFor(seeded, [snapshot(narrow())]),
      environment: 'production',
      observedAt: at(2),
    });
    await run(result.statements);

    // Production never returned `name`, so nothing about it has changed. Only
    // sandbox ever did.
    expect(result.changes.map((c) => c.fieldPath)).not.toContain('response.name');
    expect(result.changes).toEqual([]);
  });

  it('still compares within one environment', async () => {
    const seeded = await seedApi();

    await run(
      (await buildCanaryStatements(db, { ...inputFor(seeded, [snapshot(wide())]), environment: 'production' })).statements,
    );
    const result = await buildCanaryStatements(db, {
      ...inputFor(seeded, [snapshot(narrow())]),
      environment: 'production',
    });

    expect(result.changes.map((c) => c.fieldPath)).toContain('response.name');
  });
})

// operation_stability was one-way. canaryRun is its only writer, and it only
// ever set 'drifted' — so an operation that drifted once carried the label
// even after the provider fixed it, and only a re-import cleared it, because a
// new spec version brings fresh `actions` rows at the column default. A
// permanent label for a temporary condition is a claim that stops being true.
describe('operation stability can recover', () => {
  const documented = () => seen({ id: 'x', name: 'Rex' }, 3);
  const extra = () => seen({ id: 'x', name: 'Rex', surprise: 'y' }, 3);

  const stabilityOf = async (specVersionId: string) => {
    const rows = await db
      .select({ key: schema.actions.actionKey, stability: schema.actions.operationStability })
      .from(schema.actions)
      .where(eq(schema.actions.specVersionId, specVersionId));
    return rows[0]?.stability;
  };

  it('clears drifted once the live shape matches the spec again', async () => {
    const seeded = await seedApi();

    // An undocumented field appears: the operation drifts.
    await run((await buildCanaryStatements(db, inputFor(seeded, [snapshot(extra())]))).statements);
    expect(await stabilityOf(seeded.specVersionId)).toBe('drifted');

    // The provider removes it again.
    const recovered = await buildCanaryStatements(db, inputFor(seeded, [snapshot(documented())]));
    await run(recovered.statements);

    expect(recovered.consistentActionKeys).toEqual(['a1']);
    expect(await stabilityOf(seeded.specVersionId)).toBe('documented');
  });

  // Clearing a warning because nothing was observed is the same mistake as
  // publishing a green score off zero successful calls.
  it('does not clear drifted for an operation it could not check', async () => {
    const seeded = await seedApi();

    await run((await buildCanaryStatements(db, inputFor(seeded, [snapshot(extra())]))).statements);
    expect(await stabilityOf(seeded.specVersionId)).toBe('drifted');

    // A run in which this operation produced no snapshot at all.
    const empty = await buildCanaryStatements(db, inputFor(seeded, []));
    await run(empty.statements);

    expect(empty.consistentActionKeys).toEqual([]);
    expect(await stabilityOf(seeded.specVersionId)).toBe('drifted');
  });
});
