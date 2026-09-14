// GAP_ANALYSIS_2026-08-04.md §0.5.
//
// analyze-crawl and analyze-enrich caught their own failures, chained forward
// and returned 200 — so QStash, which retries on a non-2xx, never got the
// chance, and a transient failure was PERMANENT for that spec version.
//
// The chaining-forward is deliberate and stays: a failed doc crawl is not fatal
// because enrichment still has the spec. What was missing is any attempt in
// between, and the property that matters is that adding retries cannot let the
// pipeline stall.

import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { attemptsSoFar, shouldRetryStage, MAX_STAGE_ATTEMPTS } from '../analysisRetry';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

let seq = 0;
async function seed() {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `AR Org ${seq}`, slug: `ar-org-${seq}` }).returning();
  const [api] = await db
    .insert(schema.apis)
    .values({ orgId: org.id, slug: `ar-api-${seq}`, name: `AR ${seq}` })
    .returning();
  const [version] = await db
    .insert(schema.specVersions)
    .values({ apiId: api.id, source: 'openapi', contentHash: `ar-${seq}`, parseStatus: 'parsed' })
    .returning();
  return { apiId: api.id, specVersionId: version.id };
}

async function recordAttempt(apiId: string, specVersionId: string, stage: string, status = 'failed') {
  await db.insert(schema.analysisRuns).values({ apiId, specVersionId, stage, status });
}

describe('counting attempts', () => {
  it('starts at zero before a stage has run', async () => {
    const { apiId, specVersionId } = await seed();
    expect(await attemptsSoFar(db, apiId, specVersionId, 'crawl')).toBe(0);
  });

  it('counts each recorded run of that stage', async () => {
    const { apiId, specVersionId } = await seed();
    await recordAttempt(apiId, specVersionId, 'crawl');
    await recordAttempt(apiId, specVersionId, 'crawl');
    expect(await attemptsSoFar(db, apiId, specVersionId, 'crawl')).toBe(2);
  });

  it('counts each stage separately', async () => {
    const { apiId, specVersionId } = await seed();
    await recordAttempt(apiId, specVersionId, 'crawl');
    await recordAttempt(apiId, specVersionId, 'enrich');
    await recordAttempt(apiId, specVersionId, 'enrich');

    expect(await attemptsSoFar(db, apiId, specVersionId, 'crawl')).toBe(1);
    expect(await attemptsSoFar(db, apiId, specVersionId, 'enrich')).toBe(2);
  });

  // A re-import gets its own spec version and therefore its own attempts: a
  // previous version's exhausted retries must not deny the new one a try.
  it('does not carry attempts across spec versions', async () => {
    const first = await seed();
    const second = await seed();
    await recordAttempt(first.apiId, first.specVersionId, 'crawl');

    expect(await attemptsSoFar(db, second.apiId, second.specVersionId, 'crawl')).toBe(0);
  });
});

describe('the retry decision', () => {
  it('retries while attempts remain', () => {
    expect(shouldRetryStage(1)).toBe(true);
    expect(shouldRetryStage(MAX_STAGE_ATTEMPTS - 1)).toBe(true);
  });

  // THE property. Once attempts are exhausted the route falls through to
  // exactly its previous behaviour, so the pipeline can never stall — which is
  // what the original always-chain-forward design was protecting.
  it('stops asking once the budget is spent, so the chain always proceeds', () => {
    expect(shouldRetryStage(MAX_STAGE_ATTEMPTS)).toBe(false);
    expect(shouldRetryStage(MAX_STAGE_ATTEMPTS + 5)).toBe(false);
  });

  it('bounds a permanent failure to a small, known cost', () => {
    const asked = Array.from({ length: 10 }, (_, i) => shouldRetryStage(i + 1)).filter(Boolean).length;
    expect(asked).toBe(MAX_STAGE_ATTEMPTS - 1);
  });
});
