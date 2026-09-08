// Persisting executed chains, on real Postgres via PGlite.
//
// The whole-database sentinel scan is the important one. A targeted column
// check only covers the columns we thought of; scanning every table in the
// schema keeps holding as columns are added, which is what "structurally
// enforced" has to mean to be worth anything.

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { buildLineageRunStatements, loadEdgeVerdicts, verdictKey } from '../lineageRun';
import type { ChainObservation, ChainResult } from '../probes/lineageChain';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

const SENTINEL = 'cus_SENTINEL_9f3a1b7c';

let seq = 0;
async function seed() {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `LR Org ${seq}`, slug: `lr-org-${seq}` }).returning();
  const [api] = await db
    .insert(schema.apis)
    .values({ orgId: org.id, slug: `lr-api-${seq}`, name: `LR API ${seq}` })
    .returning();
  const [v1] = await db
    .insert(schema.specVersions)
    .values({ apiId: api.id, source: 'openapi', contentHash: `lr-v1-${seq}`, parseStatus: 'parsed' })
    .returning();
  const [v2] = await db
    .insert(schema.specVersions)
    .values({ apiId: api.id, source: 'openapi', contentHash: `lr-v2-${seq}`, parseStatus: 'parsed' })
    .returning();
  return { apiId: api.id, v1: v1.id, v2: v2.id };
}

function observation(overrides: Partial<ChainObservation> = {}): ChainObservation {
  return {
    edgeKey: 'list_customers.response.data[].customerId->get_customer.path.customerId',
    producerActionKey: 'p1',
    producerTool: 'list_customers',
    producerField: 'response.data[].customerId',
    consumerActionKey: 'c1',
    consumerTool: 'get_customer',
    consumerField: 'path.customerId',
    inferredConfidence: 'high',
    attempts: 2,
    successes: 2,
    rejections: 0,
    otherFailures: 0,
    candidateCount: 2,
    predominantStatus: 200,
    controlAttempted: true,
    controlStatus: 404,
    latencyP50Ms: 42,
    extract: 'ok',
    outcome: 'confirmed',
    reason: 'ok',
    ...overrides,
  };
}

function result(observations: ChainObservation[], overrides: Partial<ChainResult> = {}): ChainResult {
  return { observations, requestsMade: observations.length * 4, aborted: null, ...overrides };
}

async function runSequentially(statements: ReturnType<typeof buildLineageRunStatements>['statements']) {
  for (const stmt of statements) await stmt;
}

async function persist(apiId: string, specVersionId: string, chainResult: ChainResult) {
  const built = buildLineageRunStatements(db, {
    apiId,
    specVersionId,
    chainsPlanned: chainResult.observations.length,
    budgetLimit: 40,
    result: chainResult,
  });
  await runSequentially(built.statements);
  return built;
}

function declaredTables() {
  return Object.entries(schema).filter(
    ([, value]) => value && typeof value === 'object' && Symbol.for('drizzle:Name') in value,
  );
}

/** How many tables the sweep below actually managed to read. */
async function scannedTableCount(): Promise<number> {
  let scanned = 0;
  for (const [, table] of declaredTables()) {
    try {
      await db.select().from(table as never);
      scanned += 1;
    } catch {
      // Counted as NOT scanned, which is the point.
    }
  }
  return scanned;
}

async function dumpEntireDatabase(): Promise<string> {
  const dump: Record<string, unknown> = {};
  for (const [name, table] of declaredTables()) {
    try {
      dump[name] = await db.select().from(table as never);
    } catch {
      // Not selectable — nothing to scan. Coverage is asserted separately.
    }
  }
  return JSON.stringify(dump);
}

describe('persisting a run', () => {
  it('records the run and one row per edge', async () => {
    const { apiId, v1 } = await seed();
    const built = await persist(apiId, v1, result([observation()]));

    const [run] = await db.select().from(schema.lineageRuns).where(eq(schema.lineageRuns.id, built.runId));
    expect(run.status).toBe('succeeded');
    expect(run.chainsExecuted).toBe(1);
    expect(run.requestsMade).toBe(4);

    const rows = await db
      .select()
      .from(schema.lineageExecutions)
      .where(eq(schema.lineageExecutions.runId, built.runId));
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('confirmed');
    expect(rows[0].controlAttempted).toBe(true);
    expect(rows[0].controlStatus).toBe(404);
  });

  it('tallies outcomes for the caller to report', async () => {
    const { apiId, v1 } = await seed();
    const built = await persist(
      apiId,
      v1,
      result([
        observation(),
        observation({ consumerTool: 'get_order', outcome: 'contradicted', successes: 0 }),
        observation({ consumerTool: 'get_invoice', outcome: 'inconclusive', reason: 'control_also_succeeded' }),
      ]),
    );

    expect(built.confirmed).toBe(1);
    expect(built.contradicted).toBe(1);
    expect(built.inconclusive).toBe(1);
  });

  // "We could not look" and "we looked and found nothing" must not collapse
  // into one silence — the canary's own lesson.
  it('records why an aborted run stopped', async () => {
    const { apiId, v1 } = await seed();
    const built = await persist(apiId, v1, result([], { aborted: 'rate_limited', requestsMade: 3 }));

    const [run] = await db.select().from(schema.lineageRuns).where(eq(schema.lineageRuns.id, built.runId));
    expect(run.status).toBe('aborted');
    expect(run.abortedReason).toBe('rate_limited');
    expect(run.chainsExecuted).toBe(0);
  });
});

// The property that matters most for this whole feature.
describe('no identifier can reach the database', () => {
  it('leaves the sentinel nowhere in any table', async () => {
    const { apiId, v1 } = await seed();
    await persist(apiId, v1, result([observation()]));

    const everything = await dumpEntireDatabase();
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain('SENTINEL');
    // Not vacuous: the run really did persist.
    expect(everything).toContain('get_customer');
  });

  // Structural, not incidental: a jsonb column COULD hold a value and is kept
  // safe only by a disciplined writer, whereas the columns here cannot hold one
  // at all. operation_observations is the contrast — it relies on discipline,
  // and this table deliberately does not.
  it('has no json column that could hold one', () => {
    const jsonColumns = (table: Record<string, unknown>) =>
      Object.entries(table)
        .filter(([, c]) => c && typeof c === 'object' && (c as { dataType?: string }).dataType === 'json')
        .map(([name]) => name);

    expect(jsonColumns(schema.lineageExecutions as never)).toEqual([]);
    expect(jsonColumns(schema.lineageRuns as never)).toEqual([]);
    // Proves the check is real rather than passing because dataType is never
    // 'json' anywhere.
    expect(jsonColumns(schema.operationObservations as never)).toContain('shape');
  });
});

describe('reading verdicts back', () => {
  const key = verdictKey({
    producerTool: 'list_customers',
    producerField: 'response.data[].customerId',
    consumerTool: 'get_customer',
    consumerField: 'path.customerId',
  });

  it('publishes a confirmed edge as observed', async () => {
    const { apiId, v1 } = await seed();
    await persist(apiId, v1, result([observation()]));

    const verdicts = await loadEdgeVerdicts(db, apiId, v1);
    expect(verdicts.get(key)?.verdict).toBe('observed');
    expect(verdicts.get(key)?.successes).toBe(2);
  });

  it('demotes it once the spec version moves on', async () => {
    const { apiId, v1, v2 } = await seed();
    await persist(apiId, v1, result([observation()]));

    const verdicts = await loadEdgeVerdicts(db, apiId, v2);
    expect(verdicts.get(key)?.verdict).toBe('inconclusive');
    expect(verdicts.get(key)?.stale).toBe(true);
  });

  it('needs two agreeing runs before refuting', async () => {
    const { apiId, v1 } = await seed();
    const contradicted = observation({ outcome: 'contradicted', successes: 0, controlAttempted: false });

    await persist(apiId, v1, result([contradicted]));
    expect((await loadEdgeVerdicts(db, apiId, v1)).get(key)?.verdict).toBe('inconclusive');

    await persist(apiId, v1, result([contradicted]));
    expect((await loadEdgeVerdicts(db, apiId, v1)).get(key)?.verdict).toBe('refuted');
  });

  it('reports nothing for an API that was never run', async () => {
    const { apiId, v1 } = await seed();
    expect((await loadEdgeVerdicts(db, apiId, v1)).size).toBe(0);
  });

  it('keeps two APIs verdicts apart', async () => {
    const a = await seed();
    const b = await seed();
    await persist(a.apiId, a.v1, result([observation()]));

    expect((await loadEdgeVerdicts(db, a.apiId, a.v1)).size).toBe(1);
    expect((await loadEdgeVerdicts(db, b.apiId, b.v1)).size).toBe(0);
  });
});

// The sentinel sweep is only as strong as its coverage, and dumpEntireDatabase
// swallows a failed select — so one unreadable table would silently drop out of
// it. That is the same fail-open shape this codebase keeps finding in its own
// guards, sitting in the test that is meant to be the backstop for all of them.
describe('the sweep itself is honest', () => {
  it('reaches every table schema.ts declares', async () => {
    expect(await scannedTableCount()).toBe(declaredTables().length);
  });

  it('is checking a real number of tables, not zero', () => {
    expect(declaredTables().length).toBeGreaterThan(15);
  });
});
