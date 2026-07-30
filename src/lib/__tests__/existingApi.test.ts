import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { findOrgApiForSpec, specContentHash } from '../existingApi';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

let seq = 0;
async function makeOrg(): Promise<string> {
  const suffix = `existing-${seq++}`;
  const [org] = await db.insert(schema.orgs).values({ name: suffix, slug: suffix }).returning();
  return org.id;
}

// Creates an api whose current version is `hash`, optionally tracking `sourceUrl`.
async function makeApi(
  orgId: string,
  slug: string,
  hash: string,
  opts: { sourceUrl?: string; analysisStatus?: string } = {},
) {
  const [api] = await db
    .insert(schema.apis)
    .values({ orgId, slug, name: slug, analysisStatus: opts.analysisStatus ?? 'complete' })
    .returning();
  const [version] = await db
    .insert(schema.specVersions)
    .values({
      apiId: api.id,
      source: 'openapi',
      sourceUrl: opts.sourceUrl,
      contentHash: hash,
      parseStatus: 'parsed',
    })
    .returning();
  await db.update(schema.apis).set({ currentSpecVersionId: version.id }).where(eq(schema.apis.id, api.id));
  return { apiId: api.id, versionId: version.id };
}

describe('findOrgApiForSpec', () => {
  it('returns null when the org has never seen the spec', async () => {
    const orgId = await makeOrg();
    expect(await findOrgApiForSpec(db, orgId, { contentHash: specContentHash('unseen') })).toBeNull();
  });

  it('matches identical bytes and reports them as the current spec (no re-analysis needed)', async () => {
    const orgId = await makeOrg();
    const hash = specContentHash('spec-a');
    const { apiId } = await makeApi(orgId, 'api-a', hash);

    const found = await findOrgApiForSpec(db, orgId, { contentHash: hash });
    expect(found).toMatchObject({ apiId, slug: 'api-a', isCurrentSpec: true, analysisStatus: 'complete' });
  });

  it('matches a changed spec by source URL and reports it is NOT the current spec', async () => {
    const orgId = await makeOrg();
    const url = 'https://api.example.com/openapi.json';
    const { apiId } = await makeApi(orgId, 'api-b', specContentHash('v1'), { sourceUrl: url });

    const found = await findOrgApiForSpec(db, orgId, { contentHash: specContentHash('v2'), sourceUrl: url });
    expect(found).toMatchObject({ apiId, isCurrentSpec: false });
  });

  it('never matches another org’s API', async () => {
    const mine = await makeOrg();
    const theirs = await makeOrg();
    const hash = specContentHash('shared-public-spec');
    await makeApi(theirs, 'api-theirs', hash, { sourceUrl: 'https://shared.example.com/spec.json' });

    expect(await findOrgApiForSpec(db, mine, { contentHash: hash })).toBeNull();
    expect(
      await findOrgApiForSpec(db, mine, {
        contentHash: hash,
        sourceUrl: 'https://shared.example.com/spec.json',
      }),
    ).toBeNull();
  });

  it('surfaces analysisStatus so the caller can retry a failed run on identical bytes', async () => {
    const orgId = await makeOrg();
    const hash = specContentHash('spec-failed');
    await makeApi(orgId, 'api-failed', hash, { analysisStatus: 'failed' });

    const found = await findOrgApiForSpec(db, orgId, { contentHash: hash });
    expect(found).toMatchObject({ isCurrentSpec: true, analysisStatus: 'failed' });
  });
});
