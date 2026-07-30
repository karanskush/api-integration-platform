import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { getOrCreateSystemOrg, SYSTEM_ORG_SLUG } from '../seedSystemOrg';
import { createTestDb, type TestDb } from './testDb';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

async function makeOrgWithUser(db: TestDb, suffix: string) {
  const [org] = await db.insert(schema.orgs).values({ name: `Org ${suffix}`, slug: `org-${suffix}` }).returning();
  const [user] = await db
    .insert(schema.users)
    .values({ clerkUserId: `clerk_${suffix}`, email: `${suffix}@example.com` })
    .returning();
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: 'owner' });
  return { org, user };
}

describe('schema constraints', () => {
  it('enforces the org_members composite primary key (no duplicate membership rows)', async () => {
    const { org, user } = await makeOrgWithUser(db, 'a');
    await expect(db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: 'admin' })).rejects.toThrow();
  });

  it('enforces unique api slugs', async () => {
    const { org } = await makeOrgWithUser(db, 'b');
    await db.insert(schema.apis).values({ orgId: org.id, slug: 'dup-slug', name: 'First' });
    await expect(db.insert(schema.apis).values({ orgId: org.id, slug: 'dup-slug', name: 'Second' })).rejects.toThrow();
  });

  it('treats an identical spec re-import (same api_id + content_hash) as a no-op via onConflictDoNothing', async () => {
    const { org } = await makeOrgWithUser(db, 'c');
    const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: 'versioned-api', name: 'Versioned' }).returning();

    const insertOnce = () =>
      db
        .insert(schema.specVersions)
        .values({ apiId: api.id, source: 'openapi', contentHash: 'hash-1', parseStatus: 'parsed' })
        .onConflictDoNothing()
        .returning();

    const first = await insertOnce();
    expect(first).toHaveLength(1);
    const second = await insertOnce();
    expect(second).toHaveLength(0); // identical bytes -> no new version row

    const all = await db.select().from(schema.specVersions).where(eq(schema.specVersions.apiId, api.id));
    expect(all).toHaveLength(1);
  });

  it('allows a changed content hash to create a new spec version', async () => {
    const { org } = await makeOrgWithUser(db, 'd');
    const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: 'changing-api', name: 'Changing' }).returning();

    await db.insert(schema.specVersions).values({ apiId: api.id, source: 'openapi', contentHash: 'hash-a', parseStatus: 'parsed' });
    await db.insert(schema.specVersions).values({ apiId: api.id, source: 'openapi', contentHash: 'hash-b', parseStatus: 'parsed' });

    const all = await db.select().from(schema.specVersions).where(eq(schema.specVersions.apiId, api.id));
    expect(all).toHaveLength(2);
  });

  it('dedupes waitlist emails without leaking membership (onConflictDoNothing, {ok:true} either way)', async () => {
    const insertOnce = () =>
      db.insert(schema.waitlist).values({ email: 'dupe@example.com', source: 'landing' }).onConflictDoNothing().returning();

    expect(await insertOnce()).toHaveLength(1);
    expect(await insertOnce()).toHaveLength(0);

    const rows = await db.select().from(schema.waitlist).where(eq(schema.waitlist.email, 'dupe@example.com'));
    expect(rows).toHaveLength(1);
  });

  it('dedupes stripe webhook redelivery via the stripe_events primary key', async () => {
    const insertOnce = () =>
      db.insert(schema.stripeEvents).values({ id: 'evt_123', type: 'checkout.session.completed' }).onConflictDoNothing().returning();

    expect(await insertOnce()).toHaveLength(1);
    expect(await insertOnce()).toHaveLength(0);
  });

  it('cascades: deleting an org deletes its apis', async () => {
    const { org } = await makeOrgWithUser(db, 'e');
    const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: 'cascade-api', name: 'Cascade' }).returning();

    await db.delete(schema.orgs).where(eq(schema.orgs.id, org.id));

    const remaining = await db.select().from(schema.apis).where(eq(schema.apis.id, api.id));
    expect(remaining).toHaveLength(0);
  });

  it('stores evidence_facts with an open-ended kind and jsonb payload', async () => {
    const { org } = await makeOrgWithUser(db, 'f');
    const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: 'evidence-api', name: 'Evidence' }).returning();

    await db.insert(schema.evidenceFacts).values({
      apiId: api.id,
      kind: 'parser.auth_scheme', // Phase 1 kind
      source: 'parser',
      payload: { auth: 'bearer' },
    });
    await db.insert(schema.evidenceFacts).values({
      apiId: api.id,
      kind: 'dag_edge', // hypothetical Phase 2 kind — no migration needed
      source: 'probe',
      environment: 'sandbox',
      payload: { from: 'create_payment', to: 'get_payment' },
    });

    const rows = await db.select().from(schema.evidenceFacts).where(eq(schema.evidenceFacts.apiId, api.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(['dag_edge', 'parser.auth_scheme']);
  });

  it('enforces one current scores row per api via the api_id unique index', async () => {
    const { org } = await makeOrgWithUser(db, 'g');
    const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: 'scored-api', name: 'Scored' }).returning();
    const [specVersion] = await db
      .insert(schema.specVersions)
      .values({ apiId: api.id, source: 'openapi', contentHash: 'hash-g', parseStatus: 'parsed' })
      .returning();

    await db.insert(schema.scores).values({
      apiId: api.id,
      specVersionId: specVersion.id,
      total: 80,
      authClarity: 20,
      idempotency: 20,
      explanation: [],
    });

    await expect(
      db.insert(schema.scores).values({
        apiId: api.id,
        specVersionId: specVersion.id,
        total: 90,
        authClarity: 25,
        idempotency: 25,
        explanation: [],
      }),
    ).rejects.toThrow();
  });

  // The enriched spec derives x-docentapi-human-verified from answered rows, so
  // "only a human can answer" has to hold at the database level rather than by
  // convention in whichever code path happens to do the update.
  it('refuses to mark a clarification answered by anything but a human', async () => {
    const { org } = await makeOrgWithUser(db, 'clarify');
    const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: 'clarify-api', name: 'Clarify' }).returning();
    const [specVersion] = await db
      .insert(schema.specVersions)
      .values({ apiId: api.id, contentHash: 'hash-clarify', source: 'openapi', parseStatus: 'parsed' })
      .returning();

    const row = { apiId: api.id, specVersionId: specVersion.id, kind: 'ambiguous_origin', question: 'Where from?' };

    await expect(
      db.insert(schema.clarifications).values({ ...row, status: 'answered', answerSource: 'llm', answer: 'guessed' }),
    ).rejects.toThrow();

    // A human answer, and a non-human row left unanswered, are both fine.
    await db.insert(schema.clarifications).values({ ...row, status: 'answered', answerSource: 'human', answer: 'the server assigns it' });
    await db.insert(schema.clarifications).values({ ...row, status: 'pending', answerSource: 'llm' });
  });

  it('allows one clarification group per spec version, so a retried job cannot duplicate it', async () => {
    const { org } = await makeOrgWithUser(db, 'groups');
    const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: 'group-api', name: 'Groups' }).returning();
    const [specVersion] = await db
      .insert(schema.specVersions)
      .values({ apiId: api.id, contentHash: 'hash-groups', source: 'openapi', parseStatus: 'parsed' })
      .returning();

    const row = { apiId: api.id, specVersionId: specVersion.id, kind: 'ambiguous_origin', question: 'Where from?' };

    await db.insert(schema.clarifications).values({ ...row, groupKey: 'ambiguous_origin|pet|pet_id' });
    await expect(
      db.insert(schema.clarifications).values({ ...row, groupKey: 'ambiguous_origin|pet|pet_id' }),
    ).rejects.toThrow();

    // The index is partial, so unclustered rows are still free to repeat.
    await db.insert(schema.clarifications).values(row);
    await db.insert(schema.clarifications).values(row);
  });

  it('getOrCreateSystemOrg is idempotent and creates exactly one system org', async () => {
    const first = await getOrCreateSystemOrg(db);
    const second = await getOrCreateSystemOrg(db);

    expect(first.id).toBe(second.id);
    expect(first.slug).toBe(SYSTEM_ORG_SLUG);

    const systemOrgs = await db.select().from(schema.orgs).where(eq(schema.orgs.isSystem, true));
    expect(systemOrgs).toHaveLength(1);
    expect(systemOrgs[0].id).toBe(first.id);
  });
});
