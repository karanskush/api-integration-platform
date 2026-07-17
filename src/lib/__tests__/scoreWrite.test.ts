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

    const result = await buildScoreRunStatements(db, { apiId, specVersionId, total: 70, subscores: subscores(), evidence });
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

    const result = await buildScoreRunStatements(db, { apiId, specVersionId, total: 50, subscores: subscores(), evidence });
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

    const result = await buildScoreRunStatements(db, { apiId, specVersionId, total: 60, subscores: subscores(), evidence });
    await runSequentially(result.statements);

    const [fact] = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, apiId));
    expect(fact.actionId).toBeNull();
  });
});
