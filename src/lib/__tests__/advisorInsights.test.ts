// The first tests for advisor/insights.ts, added alongside the change that made
// it read llm.field_semantics.
//
// insights.ts reads through the module-level getDb(), so this uses the same
// stub seam visibility.test.ts established rather than threading a db argument
// through a function whose whole job is to be callable from a route.
//
// The version-fencing assertions are the point: a semantic claim names a
// specific field, and a field described against a superseded spec version may
// not exist in the current one. Handing an agent the old meaning would be worse
// than handing it none.

import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';

let db: TestDb;

const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://stub/stub';
});

afterEach(() => {
  vi.resetModules();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

async function loadInsights() {
  vi.resetModules();
  vi.doMock('../db', () => ({
    dbReady: () => Boolean(process.env.DATABASE_URL),
    getDb: () => db,
  }));
  return import('../advisor/insights');
}

let seq = 0;

// Two spec versions per API, so every test can express "current" vs
// "superseded" without extra setup.
async function seed() {
  seq += 1;
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: `Insights Org ${seq}`, slug: `insights-org-${seq}` })
    .returning();
  const [api] = await db
    .insert(schema.apis)
    .values({ orgId: org.id, slug: `insights-api-${seq}`, name: `Insights API ${seq}` })
    .returning();

  const [oldVersion] = await db
    .insert(schema.specVersions)
    .values({ apiId: api.id, source: 'openapi', contentHash: `old-${seq}`, parseStatus: 'parsed' })
    .returning();
  const [currentVersion] = await db
    .insert(schema.specVersions)
    .values({ apiId: api.id, source: 'openapi', contentHash: `cur-${seq}`, parseStatus: 'parsed' })
    .returning();

  await db
    .update(schema.apis)
    .set({ currentSpecVersionId: currentVersion.id })
    .where(eq(schema.apis.id, api.id));

  return { apiId: api.id, slug: api.slug, oldVersionId: oldVersion.id, currentVersionId: currentVersion.id };
}

async function addSemantics(
  apiId: string,
  specVersionId: string,
  payload: { tool: string; field: string; semanticMeaning: string; businessConstraint?: string; sourcedFrom: 'spec' | 'docs' },
  observedAt?: Date,
) {
  await db.insert(schema.evidenceFacts).values({
    apiId,
    specVersionId,
    kind: 'llm.field_semantics',
    source: 'llm',
    payload,
    ...(observedAt ? { observedAt } : {}),
  });
}

describe('loadAdvisorInsights — field semantics', () => {
  it('reads back what the enrichment pass concluded', async () => {
    const { apiId, slug, currentVersionId } = await seed();
    await addSemantics(apiId, currentVersionId, {
      tool: 'create_charge',
      field: 'body.amount',
      semanticMeaning: 'Amount in the smallest currency unit.',
      businessConstraint: 'Must be at least 50.',
      sourcedFrom: 'docs',
    });

    const { loadAdvisorInsights } = await loadInsights();
    const insights = await loadAdvisorInsights(slug);

    expect(insights.fieldSemantics).toHaveLength(1);
    expect(insights.fieldSemantics[0]).toEqual({
      tool: 'create_charge',
      field: 'body.amount',
      meaning: 'Amount in the smallest currency unit.',
      constraint: 'Must be at least 50.',
      sourcedFrom: 'docs',
    });
  });

  it('withholds semantics written against a superseded spec version', async () => {
    const { apiId, slug, oldVersionId } = await seed();
    await addSemantics(apiId, oldVersionId, {
      tool: 'create_charge',
      field: 'body.legacy_field',
      semanticMeaning: 'A field that may no longer exist.',
      sourcedFrom: 'docs',
    });

    const { loadAdvisorInsights } = await loadInsights();
    const insights = await loadAdvisorInsights(slug);

    expect(insights.fieldSemantics).toHaveLength(0);
  });

  it('keeps the newest reading when a later pass revised one', async () => {
    const { apiId, slug, currentVersionId } = await seed();
    await addSemantics(
      apiId,
      currentVersionId,
      { tool: 'create_charge', field: 'body.amount', semanticMeaning: 'Stale reading.', sourcedFrom: 'spec' },
      new Date('2026-01-01T00:00:00Z'),
    );
    await addSemantics(
      apiId,
      currentVersionId,
      { tool: 'create_charge', field: 'body.amount', semanticMeaning: 'Revised reading.', sourcedFrom: 'docs' },
      new Date('2026-06-01T00:00:00Z'),
    );

    const { loadAdvisorInsights } = await loadInsights();
    const insights = await loadAdvisorInsights(slug);

    expect(insights.fieldSemantics).toHaveLength(1);
    expect(insights.fieldSemantics[0].meaning).toBe('Revised reading.');
  });

  it('survives a malformed historical payload rather than failing the tool call', async () => {
    const { apiId, slug, currentVersionId } = await seed();
    await db.insert(schema.evidenceFacts).values({
      apiId,
      specVersionId: currentVersionId,
      kind: 'llm.field_semantics',
      source: 'llm',
      payload: { nonsense: true },
    });
    await addSemantics(apiId, currentVersionId, {
      tool: 'create_charge',
      field: 'body.amount',
      semanticMeaning: 'Still readable.',
      sourcedFrom: 'docs',
    });

    const { loadAdvisorInsights } = await loadInsights();
    const insights = await loadAdvisorInsights(slug);

    expect(insights.fieldSemantics).toHaveLength(1);
    expect(insights.fieldSemantics[0].meaning).toBe('Still readable.');
  });

  it('returns an empty list for an API that was never enriched', async () => {
    const { slug } = await seed();
    const { loadAdvisorInsights } = await loadInsights();
    expect((await loadAdvisorInsights(slug)).fieldSemantics).toEqual([]);
  });

  it('returns empty insights for an unknown slug', async () => {
    const { loadAdvisorInsights } = await loadInsights();
    const insights = await loadAdvisorInsights('no-such-api');
    expect(insights.fieldSemantics).toEqual([]);
    expect(insights.verified).toBeNull();
  });
});

// A minimal answer space: one option that reclassifies the field, one that
// confirms it without doing so. originForAnswer resolves the choice against
// this exact set, never against whatever a client sent.
const ANSWER_SPEC = {
  kind: 'choice',
  allowOther: false,
  options: [
    { label: 'The server assigns it', value: 'server', resolvedOrigin: 'server_generated' },
    { label: 'Something else entirely', value: 'other_thing' },
  ],
};

async function addClarification(
  apiId: string,
  specVersionId: string,
  overrides: Record<string, unknown> = {},
) {
  await db.insert(schema.clarifications).values({
    apiId,
    specVersionId,
    kind: 'ambiguous_origin',
    question: 'Does the caller choose this value?',
    answerSpec: ANSWER_SPEC,
    status: 'answered',
    answerSource: 'human',
    answer: 'server',
    ...overrides,
  } as never);
}

describe('loadAdvisorInsights — owner answers', () => {
  it('reads back an answer a person gave, resolved to an origin', async () => {
    const { apiId, slug, currentVersionId } = await seed();
    await addClarification(apiId, currentVersionId, {
      appliesTo: [{ tool: 'create_thing', fieldPath: 'body.reference' }],
    });

    const { loadAdvisorInsights } = await loadInsights();
    const insights = await loadAdvisorInsights(slug);

    expect(insights.ownerAnswers).toHaveLength(1);
    expect(insights.ownerAnswers[0]).toEqual({
      tool: 'create_thing',
      field: 'body.reference',
      origin: 'server_generated',
      question: 'Does the caller choose this value?',
    });
  });

  it('fans one clustered answer out across every site it covers', async () => {
    const { apiId, slug, currentVersionId } = await seed();
    await addClarification(apiId, currentVersionId, {
      appliesTo: [
        { tool: 'get_pet', fieldPath: 'petId' },
        { tool: 'update_pet', fieldPath: 'petId' },
        { tool: 'delete_pet', fieldPath: 'petId' },
      ],
    });

    const { loadAdvisorInsights } = await loadInsights();
    const insights = await loadAdvisorInsights(slug);

    expect(insights.ownerAnswers.map((a) => a.tool).sort()).toEqual(['delete_pet', 'get_pet', 'update_pet']);
  });

  // The answer_source column exists so a triage assumption is structurally
  // unable to reach a consumer wearing a person's authority.
  it('refuses an assumption, however confident', async () => {
    const { apiId, slug, currentVersionId } = await seed();
    await addClarification(apiId, currentVersionId, {
      status: 'assumed',
      assumedAnswer: 'server',
      appliesTo: [{ tool: 'create_thing', fieldPath: 'body.reference' }],
    });

    const { loadAdvisorInsights } = await loadInsights();
    expect((await loadAdvisorInsights(slug)).ownerAnswers).toHaveLength(0);
  });

  it('ignores a skipped question — an honest unknown is not an answer', async () => {
    const { apiId, slug, currentVersionId } = await seed();
    await addClarification(apiId, currentVersionId, {
      status: 'skipped',
      answer: null,
      appliesTo: [{ tool: 'create_thing', fieldPath: 'body.reference' }],
    });

    const { loadAdvisorInsights } = await loadInsights();
    expect((await loadAdvisorInsights(slug)).ownerAnswers).toHaveLength(0);
  });

  it('withholds answers given against a superseded spec version', async () => {
    const { apiId, slug, oldVersionId } = await seed();
    await addClarification(apiId, oldVersionId, {
      appliesTo: [{ tool: 'create_thing', fieldPath: 'body.reference' }],
    });

    const { loadAdvisorInsights } = await loadInsights();
    expect((await loadAdvisorInsights(slug)).ownerAnswers).toHaveLength(0);
  });

  it('confirms without an origin when the chosen option does not resolve to one', async () => {
    const { apiId, slug, currentVersionId } = await seed();
    await addClarification(apiId, currentVersionId, {
      answer: 'other_thing',
      appliesTo: [{ tool: 'create_thing', fieldPath: 'body.reference' }],
    });

    const { loadAdvisorInsights } = await loadInsights();
    const insights = await loadAdvisorInsights(slug);

    expect(insights.ownerAnswers).toHaveLength(1);
    expect(insights.ownerAnswers[0].origin).toBeUndefined();
  });

  it('resolves an un-clustered answer through its action row', async () => {
    const { apiId, slug, currentVersionId } = await seed();
    const [row] = await db
      .insert(schema.actions)
      .values({
        apiId,
        specVersionId: currentVersionId,
        actionKey: 'abc12345',
        name: 'create_thing',
        description: 'Create a thing',
        method: 'POST',
        path: '/things',
        paramsSchema: { type: 'object', properties: {} },
        auth: 'bearer',
        safety: 'write',
      })
      .returning();

    await addClarification(apiId, currentVersionId, {
      actionId: row.id,
      fieldPath: 'body.reference',
      appliesTo: null,
    });

    const { loadAdvisorInsights } = await loadInsights();
    const insights = await loadAdvisorInsights(slug);

    expect(insights.ownerAnswers).toEqual([
      {
        tool: 'create_thing',
        field: 'body.reference',
        origin: 'server_generated',
        question: 'Does the caller choose this value?',
      },
    ]);
  });
});
