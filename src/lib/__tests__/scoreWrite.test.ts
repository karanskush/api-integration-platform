import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import type { EvidenceFactInput } from '../evidence';
import type { Action, ImportRecord } from '../ir';
import { buildPersistStatements } from '../persist';
import { buildScoreRunStatements, type ScoreRunInput } from '../scoreWrite';

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
  const [org] = await db.insert(schema.orgs).values({ name: `Org ${suffix}`, slug: `score-org-${suffix}` }).returning();
  return org;
}

// Runs a persistApi()-shaped statement list through the real api/specVersion/
// actions rows a score run needs to link against, without needing a Neon
// connection — same rationale as persist.test.ts's own runSequentially.
async function makeApi(suffix: string) {
  const org = await makeOrg(suffix);
  const result = await buildPersistStatements(db, { orgId: org.id, record: record(), rawText: `raw-${suffix}` });
  for (const stmt of result.statements) await stmt;
  return result;
}

async function runSequentially(statements: Awaited<ReturnType<typeof buildScoreRunStatements>>['statements']) {
  for (const stmt of statements) await stmt;
}

function subscores(overrides: Partial<ScoreRunInput['subscores']> = {}): ScoreRunInput['subscores'] {
  return { authClarity: 20, errorQuality: 15, docDrift: 10, idempotency: 25, ...overrides };
}

// Every fixture here describes a run that actually reached the API. The
// zero-success case has its own tests below, because it is now the branch that
// writes no scores row at all.
function reached() {
  return {
    liveCalls: { attempted: 3, succeeded: 2, failed: 1 },
    points: { observed: 20, static: 45, max: 75 },
  };
}

describe('buildScoreRunStatements', () => {
  it('inserts evidence facts and a scores row linked to the api, resolving actionId to the actions row uuid', async () => {
    const { apiId, specVersionId } = await makeApi('a');
    const evidence: EvidenceFactInput[] = [
      {
        kind: 'probe.auth_reject',
        source: 'probe',
        actionId: 'a1',
        payload: { statusObserved: 401, expectedAuth: 'bearer' },
      },
    ];

    const result = await buildScoreRunStatements(db, { apiId, specVersionId, total: 70, subscores: subscores(), ...reached(), evidence });
    await runSequentially(result.statements);

    const allFacts = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, apiId));
    const facts = allFacts.filter((f) => f.kind.startsWith('probe.'));
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe('probe.auth_reject');
    expect(facts[0].source).toBe('probe');
    expect(facts[0].environment).toBe('production');

    const [actionRow] = await db.select().from(schema.actions).where(eq(schema.actions.apiId, apiId));
    expect(facts[0].actionId).toBe(actionRow.id);

    const [score] = await db.select().from(schema.scores).where(eq(schema.scores.apiId, apiId));
    expect(score.total).toBe(70);
    expect(score.authClarity).toBe(20);
    expect(score.specVersionId).toBe(specVersionId);
    const explanation = score.explanation as Array<{ factId: string; message: string }>;
    expect(explanation).toHaveLength(1);
    expect(explanation[0].factId).toBe(facts[0].id);
  });

  it('marks idempotency-signal evidence static and other probe evidence production', async () => {
    const { apiId, specVersionId } = await makeApi('b');
    const evidence: EvidenceFactInput[] = [
      {
        kind: 'probe.idempotency_signal',
        source: 'probe',
        actionId: 'a1',
        payload: { actionId: 'a1', hasIdempotencySignal: false },
      },
    ];

    const result = await buildScoreRunStatements(db, { apiId, specVersionId, total: 50, subscores: subscores(), ...reached(), evidence });
    await runSequentially(result.statements);

    const [fact] = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, apiId));
    expect(fact.environment).toBe('static');
  });

  it('running it twice for the same apiId updates the same scores row rather than creating a second one', async () => {
    const { apiId, specVersionId } = await makeApi('c');

    const first = await buildScoreRunStatements(db, {
      apiId,
      specVersionId,
      total: 40,
      subscores: subscores({ authClarity: 10 }),
      ...reached(),
      evidence: [
        { kind: 'probe.auth_reject', source: 'probe', actionId: 'a1', payload: { statusObserved: 401, expectedAuth: 'bearer' } },
      ],
    });
    await runSequentially(first.statements);

    const second = await buildScoreRunStatements(db, {
      apiId,
      specVersionId,
      total: 90,
      subscores: subscores({ authClarity: 25 }),
      ...reached(),
      evidence: [
        {
          kind: 'probe.error_quality',
          source: 'probe',
          actionId: 'a1',
          payload: { actionId: 'a1', sampleStatus: 400, hasReadableMessage: true },
        },
      ],
    });
    await runSequentially(second.statements);

    const scoreRows = await db.select().from(schema.scores).where(eq(schema.scores.apiId, apiId));
    expect(scoreRows).toHaveLength(1);
    expect(scoreRows[0].total).toBe(90);
    expect(scoreRows[0].authClarity).toBe(25);

    const allFacts = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, apiId));
    const facts = allFacts.filter((f) => f.kind.startsWith('probe.'));
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.kind).sort()).toEqual(['probe.auth_reject', 'probe.error_quality']);
  });

  it('leaves actionId null when the evidence action key has no matching actions row', async () => {
    const { apiId, specVersionId } = await makeApi('d');
    const evidence: EvidenceFactInput[] = [
      {
        kind: 'probe.auth_reject',
        source: 'probe',
        actionId: 'does-not-exist',
        payload: { statusObserved: 401, expectedAuth: 'bearer' },
      },
    ];

    const result = await buildScoreRunStatements(db, { apiId, specVersionId, total: 60, subscores: subscores(), ...reached(), evidence });
    await runSequentially(result.statements);

    const [fact] = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, apiId));
    expect(fact.actionId).toBeNull();
  });
});

describe('buildScoreRunStatements lifecycle evidence', () => {
  const lifecycleEvidence = (at: string): EvidenceFactInput => ({
    kind: 'probe.lifecycle_signal',
    source: 'probe',
    actionId: 'a1',
    payload: {
      actionId: 'a1',
      tool: 'get_thing',
      method: 'GET',
      path: '/things/{id}',
      kind: 'sunset',
      header: 'sunset',
      raw: 'Wed, 30 Jun 2027 23:59:59 GMT',
      at,
    },
  });

  const probeEvidence: EvidenceFactInput = {
    kind: 'probe.auth_reject',
    source: 'probe',
    payload: { statusObserved: 401, expectedAuth: 'bearer' },
  };

  function input(api: { apiId: string; specVersionId: string }, evidence: EvidenceFactInput[]): ScoreRunInput {
    return {
      apiId: api.apiId,
      specVersionId: api.specVersionId,
      total: 80,
      subscores: { authClarity: 25, errorQuality: 20, docDrift: 15, idempotency: 20 },
      ...reached(),
      evidence,
    };
  }

  // The score explains what MOVED it. A provider's sunset announcement is
  // recorded, but claiming it "contributed to score" would be false.
  it('stores a lifecycle fact as evidence but keeps it out of the score explanation', async () => {
    const api = await makeApi('lifecycle-a');
    const built = await buildScoreRunStatements(db, input(api, [probeEvidence, lifecycleEvidence('2027-06-30T23:59:59.000Z')]));
    for (const statement of built.statements) await statement;

    const facts = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, api.apiId));
    expect(facts.some((f) => f.kind === 'probe.lifecycle_signal')).toBe(true);

    const [score] = await db.select().from(schema.scores).where(eq(schema.scores.apiId, api.apiId));
    const explanation = score.explanation as Array<{ message: string }>;
    expect(explanation).toHaveLength(1);
    expect(explanation[0].message).toContain('Auth clarity');
  });

  it('creates the header-sourced change row once across repeated runs', async () => {
    const api = await makeApi('lifecycle-b');
    for (let i = 0; i < 2; i++) {
      const built = await buildScoreRunStatements(db, input(api, [lifecycleEvidence('2027-06-30T23:59:59.000Z')]));
      for (const statement of built.statements) await statement;
    }

    const rows = await db.select().from(schema.apiChanges).where(eq(schema.apiChanges.apiId, api.apiId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'header', kind: 'operation.sunset_scheduled', severity: 'risky' });
    // Linked to the concrete action row, not just the stable key.
    expect(rows[0].actionId).not.toBeNull();
  });

  it('writes a second row when the announced date moves', async () => {
    const api = await makeApi('lifecycle-c');
    for (const at of ['2027-06-30T23:59:59.000Z', '2028-01-01T00:00:00.000Z']) {
      const built = await buildScoreRunStatements(db, input(api, [lifecycleEvidence(at)]));
      for (const statement of built.statements) await statement;
    }

    const rows = await db.select().from(schema.apiChanges).where(eq(schema.apiChanges.apiId, api.apiId));
    expect(rows).toHaveLength(2);
  });
});

// The gate itself (GAP_ANALYSIS_2026-08-04.md §0.2). A `scores` row is a claim
// about how an API BEHAVES, so a run in which nothing answered has not earned
// one — and must not overwrite a previously earned row with a number assembled
// from static heuristics.
describe('a run that reached nothing writes no score', () => {
  const unreachable = { liveCalls: { attempted: 4, succeeded: 0, failed: 4 }, points: { observed: 0, static: 45, max: 50 } };

  it('writes no scores row at all', async () => {
    const { apiId, specVersionId } = await makeApi('gate-none');

    const result = await buildScoreRunStatements(db, {
      apiId,
      specVersionId,
      total: 90,
      subscores: subscores(),
      ...unreachable,
      evidence: [],
    });
    await runSequentially(result.statements);

    expect(result.verified).toBe(false);
    const rows = await db.select().from(schema.scores).where(eq(schema.scores.apiId, apiId));
    expect(rows).toHaveLength(0);
  });

  it('still records the evidence, because a failed attempt is a fact worth keeping', async () => {
    const { apiId, specVersionId } = await makeApi('gate-evidence');

    const result = await buildScoreRunStatements(db, {
      apiId,
      specVersionId,
      total: 90,
      subscores: subscores(),
      ...unreachable,
      evidence: [
        { kind: 'probe.auth_reject', source: 'probe', payload: { statusObserved: 401, expectedAuth: 'bearer' } },
      ],
    });
    await runSequentially(result.statements);

    const facts = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, apiId));
    expect(facts.length).toBeGreaterThan(0);
  });

  it('leaves a previously earned score standing rather than replacing it', async () => {
    const { apiId, specVersionId } = await makeApi('gate-preserve');

    const earned = await buildScoreRunStatements(db, {
      apiId,
      specVersionId,
      total: 72,
      subscores: subscores(),
      ...reached(),
      evidence: [],
    });
    await runSequentially(earned.statements);
    expect(earned.verified).toBe(true);

    const later = await buildScoreRunStatements(db, {
      apiId,
      specVersionId,
      total: 95,
      subscores: subscores(),
      ...unreachable,
      evidence: [],
    });
    await runSequentially(later.statements);

    const [row] = await db.select().from(schema.scores).where(eq(schema.scores.apiId, apiId));
    // The real measurement stands. Its own version fencing already reports it
    // stale if the contract has moved on.
    expect(row.total).toBe(72);
  });
});

describe('a run that reached the API records its sample size', () => {
  it('persists the call counts and the observed/static split', async () => {
    const { apiId, specVersionId } = await makeApi('sample-size');

    await runSequentially(
      (
        await buildScoreRunStatements(db, {
          apiId,
          specVersionId,
          total: 80,
          subscores: subscores(),
          liveCalls: { attempted: 6, succeeded: 4, failed: 2 },
          points: { observed: 35, static: 45, max: 100 },
          evidence: [],
        })
      ).statements,
    );

    const [row] = await db.select().from(schema.scores).where(eq(schema.scores.apiId, apiId));
    expect(row.liveCallsAttempted).toBe(6);
    expect(row.liveCallsSucceeded).toBe(4);
    expect(row.observedPoints).toBe(35);
    expect(row.staticPoints).toBe(45);
  });
});
