import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { createTestDb, type TestDb } from '../../db/__tests__/testDb';
import { changeSummary, groupIntoReleases, listChanges, resolveSince } from '../query';
import type { ChangeRow } from '../ledger';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

let seq = 0;
async function seedApi() {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `Q Org ${seq}`, slug: `q-org-${seq}` }).returning();
  const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: `q-api-${seq}`, name: `Q API ${seq}` }).returning();
  const [version] = await db
    .insert(schema.specVersions)
    .values({ apiId: api.id, source: 'openapi', contentHash: `abcdef${seq}${'0'.repeat(56)}`.slice(0, 64), parseStatus: 'parsed' })
    .returning();
  await db.update(schema.apis).set({ currentSpecVersionId: version.id }).where(eq(schema.apis.id, api.id));
  return { apiId: api.id, specVersionId: version.id, contentHash: version.contentHash };
}

async function addVersion(apiId: string, contentHash: string, createdAt?: Date) {
  const [version] = await db
    .insert(schema.specVersions)
    .values({ apiId, source: 'openapi', contentHash, parseStatus: 'parsed', ...(createdAt ? { createdAt } : {}) })
    .returning();
  await db.update(schema.apis).set({ currentSpecVersionId: version.id }).where(eq(schema.apis.id, apiId));
  return version;
}

async function addChange(
  apiId: string,
  overrides: Partial<typeof schema.apiChanges.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.apiChanges)
    .values({
      apiId,
      kind: 'field.removed',
      severity: 'breaking',
      source: 'poll',
      summary: 'something changed',
      ...overrides,
    })
    .returning();
  return row;
}

describe('listChanges', () => {
  it('returns rows newest first and honours the limit', async () => {
    const { apiId } = await seedApi();
    await addChange(apiId, { summary: 'oldest', observedAt: new Date('2026-01-01T00:00:00Z') });
    await addChange(apiId, { summary: 'middle', observedAt: new Date('2026-02-01T00:00:00Z') });
    await addChange(apiId, { summary: 'newest', observedAt: new Date('2026-03-01T00:00:00Z') });

    const rows = await listChanges(db, apiId);
    expect(rows.map((r) => r.summary)).toEqual(['newest', 'middle', 'oldest']);
    expect(await listChanges(db, apiId, { limit: 2 })).toHaveLength(2);
  });

  it('filters by severity and by since', async () => {
    const { apiId } = await seedApi();
    await addChange(apiId, { severity: 'breaking', summary: 'b', observedAt: new Date('2026-01-01T00:00:00Z') });
    await addChange(apiId, { severity: 'additive', summary: 'a', observedAt: new Date('2026-06-01T00:00:00Z') });

    expect((await listChanges(db, apiId, { severity: 'additive' })).map((r) => r.summary)).toEqual(['a']);
    expect((await listChanges(db, apiId, { since: new Date('2026-03-01T00:00:00Z') })).map((r) => r.summary)).toEqual(['a']);
  });

  it('joins the spec version content hash so a row can name the version it landed in', async () => {
    const { apiId, specVersionId, contentHash } = await seedApi();
    await addChange(apiId, { toSpecVersionId: specVersionId });
    const [row] = await listChanges(db, apiId);
    expect(row.toContentHash).toBe(contentHash);
  });

  // A row written by a future build's vocabulary is skipped rather than
  // throwing on a page render or an MCP call.
  it('drops a row whose kind this build does not recognise', async () => {
    const { apiId } = await seedApi();
    await addChange(apiId, { summary: 'known' });
    await addChange(apiId, { kind: 'operation.teleported', summary: 'unknown' });

    expect((await listChanges(db, apiId)).map((r) => r.summary)).toEqual(['known']);
  });

  it('scopes to one API', async () => {
    const a = await seedApi();
    const b = await seedApi();
    await addChange(a.apiId, { summary: 'mine' });
    await addChange(b.apiId, { summary: 'theirs' });
    expect((await listChanges(db, a.apiId)).map((r) => r.summary)).toEqual(['mine']);
  });
});

describe('changeSummary', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');

  it('counts the last 30 days by severity and ignores older rows', async () => {
    const { apiId } = await seedApi();
    await addChange(apiId, { severity: 'breaking', observedAt: new Date('2026-09-01T00:00:00Z') });
    await addChange(apiId, { severity: 'additive', observedAt: new Date('2026-09-02T00:00:00Z') });
    await addChange(apiId, { severity: 'additive', observedAt: new Date('2026-09-03T00:00:00Z') });
    await addChange(apiId, { severity: 'breaking', observedAt: new Date('2026-01-01T00:00:00Z') });

    const summary = await changeSummary(db, apiId, now);
    expect(summary.counts30d).toEqual({ breaking: 1, risky: 0, additive: 2, cosmetic: 0 });
    expect(summary.total30d).toBe(3);
    expect(summary.lastChangeAt).toBe('2026-09-03T00:00:00.000Z');
  });

  it('reports the current version hash and, with no poll yet, falls back to when it was recorded', async () => {
    const { apiId, contentHash } = await seedApi();
    const summary = await changeSummary(db, apiId, now);
    expect(summary.currentVersionHash).toBe(contentHash);
    expect(summary.lastCheckedAt).not.toBeNull();
  });

  // "Checked, unchanged" is exactly what the freshness line needs to say, and
  // it is what a 304 records.
  it('prefers the poll timestamp for lastCheckedAt', async () => {
    const { apiId, specVersionId } = await seedApi();
    await db
      .update(schema.specVersions)
      .set({ lastPolledAt: new Date('2026-09-06T11:00:00.000Z') })
      .where(eq(schema.specVersions.id, specVersionId));

    expect((await changeSummary(db, apiId, now)).lastCheckedAt).toBe('2026-09-06T11:00:00.000Z');
  });

  // The first version is the import, not a change.
  it('reports no spec change for a single-version API, and the current version once one lands', async () => {
    const { apiId } = await seedApi();
    expect((await changeSummary(db, apiId, now)).lastSpecChangeAt).toBeNull();

    const second = await addVersion(apiId, `bbbbbb${'1'.repeat(58)}`.slice(0, 64));
    expect((await changeSummary(db, apiId, now)).lastSpecChangeAt).toBe(second.createdAt.toISOString());
  });
});

describe('resolveSince', () => {
  it('accepts an ISO timestamp', async () => {
    const { apiId } = await seedApi();
    expect((await resolveSince(db, apiId, '2026-09-01T00:00:00Z'))?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  // A consumer knows which spec version it integrated against, not the date.
  it('accepts a content-hash prefix and returns that version’s timestamp', async () => {
    const { apiId } = await seedApi();
    const version = await addVersion(apiId, `feedfa${'2'.repeat(58)}`.slice(0, 64));
    const resolved = await resolveSince(db, apiId, 'feedfa');
    expect(resolved?.toISOString()).toBe(version.createdAt.toISOString());
  });

  it('returns null for an unknown prefix or unparseable input', async () => {
    const { apiId } = await seedApi();
    expect(await resolveSince(db, apiId, 'ffffff')).toBeNull();
    expect(await resolveSince(db, apiId, 'last tuesday')).toBeNull();
    expect(await resolveSince(db, apiId, '')).toBeNull();
  });
});

describe('groupIntoReleases', () => {
  function row(overrides: Partial<ChangeRow> = {}): ChangeRow {
    return {
      id: `id-${Math.random()}`,
      kind: 'field.removed',
      severity: 'breaking',
      source: 'poll',
      actionKey: null,
      tool: null,
      method: null,
      path: null,
      fieldPath: null,
      location: null,
      summary: 's',
      detail: {},
      fromSpecVersionId: null,
      toSpecVersionId: 'v1',
      toContentHash: 'hash-1',
      observedAt: '2026-09-03T10:00:00.000Z',
      ...overrides,
    };
  }

  it('groups a version diff into one release and counts its severities', () => {
    const releases = groupIntoReleases([
      row({ severity: 'breaking' }),
      row({ severity: 'additive' }),
      row({ toSpecVersionId: 'v2', toContentHash: 'hash-2', severity: 'risky', observedAt: '2026-09-04T10:00:00.000Z' }),
    ]);

    expect(releases).toHaveLength(2);
    const first = releases.find((r) => r.key === 'v1')!;
    expect(first.counts).toEqual({ breaking: 1, risky: 0, additive: 1, cosmetic: 0 });
    expect(first.specVersionHash).toBe('hash-1');
  });

  // Header-observed rows belong to no version diff, so they group by the day
  // they were seen rather than piling into one unbounded bucket.
  it('groups version-less rows by UTC day', () => {
    const releases = groupIntoReleases([
      row({ toSpecVersionId: null, toContentHash: null, source: 'header', observedAt: '2026-09-03T23:00:00.000Z' }),
      row({ toSpecVersionId: null, toContentHash: null, source: 'header', observedAt: '2026-09-03T01:00:00.000Z' }),
      row({ toSpecVersionId: null, toContentHash: null, source: 'header', observedAt: '2026-09-04T01:00:00.000Z' }),
    ]);

    expect(releases.map((r) => r.key).sort()).toEqual(['observed:2026-09-03', 'observed:2026-09-04']);
    expect(releases.find((r) => r.key === 'observed:2026-09-03')!.changes).toHaveLength(2);
  });

  it('lists the distinct sources that produced a release', () => {
    const [release] = groupIntoReleases([row({ source: 'poll' }), row({ source: 'poll' }), row({ source: 'ci_push' })]);
    expect(release.sources.sort()).toEqual(['ci_push', 'poll']);
  });

  it('returns nothing for no rows', () => {
    expect(groupIntoReleases([])).toEqual([]);
  });
});
