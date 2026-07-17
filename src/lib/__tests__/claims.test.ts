import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NeonDb } from '../db';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { applyClaimVerification, verifyDnsClaim, verifyEmailClaim, verifyMetaClaim, type DnsResolver } from '../claims';
import { limitsFor } from '../plans';

let db: TestDb;
let neonDb: NeonDb;

beforeAll(async () => {
  db = await createTestDb();
  // pglite's driver implements no .batch() (only neon-http/d1 do — see
  // persist.ts's header comment on why persistApi() itself isn't unit-
  // testable this way). applyClaimVerification's batch is plain Drizzle
  // query builders, which are thenables usable standalone (same fact
  // persist.test.ts's runSequentially relies on) — so a minimal sequential
  // shim, exposed under the exact method name applyClaimVerification calls,
  // lets it run end-to-end against the pglite harness.
  (db as unknown as { batch: (items: Promise<unknown>[]) => Promise<unknown[]> }).batch = async (items) => {
    const results: unknown[] = [];
    for (const item of items) results.push(await item);
    return results;
  };
  neonDb = db as unknown as NeonDb;
}, 30_000);

let orgSeq = 0;
async function makeOrg(plan = 'free') {
  orgSeq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `Org ${orgSeq}`, slug: `claims-org-${orgSeq}`, plan }).returning();
  return org;
}

let userSeq = 0;
async function makeUser() {
  userSeq += 1;
  const [user] = await db.insert(schema.users).values({ clerkUserId: `clerk_claims_${userSeq}`, email: `claims-user-${userSeq}@example.com` }).returning();
  return user;
}

let apiSeq = 0;
async function makeApi(orgId: string, overrides: Partial<typeof schema.apis.$inferInsert> = {}) {
  apiSeq += 1;
  const [api] = await db
    .insert(schema.apis)
    .values({ orgId, slug: `claims-api-${apiSeq}`, name: `API ${apiSeq}`, claimStatus: 'unclaimed', ...overrides })
    .returning();
  return api;
}

async function makeClaim(apiId: string, userId: string, overrides: Partial<typeof schema.claims.$inferInsert> = {}) {
  const [claim] = await db
    .insert(schema.claims)
    .values({ apiId, userId, method: 'dns', domain: 'example.com', token: 'tok', status: 'pending', ...overrides })
    .returning();
  return claim;
}

describe('verifyDnsClaim', () => {
  it('returns true when the token appears in a resolved TXT record', async () => {
    const resolver: DnsResolver = async (hostname) => {
      expect(hostname).toBe('_spotcheck-verify.example.com');
      return ['unrelated', 'spotcheck-verify=abc123'];
    };
    await expect(verifyDnsClaim('example.com', 'abc123', resolver)).resolves.toBe(true);
  });

  it('returns false when the token is absent from every record', async () => {
    const resolver: DnsResolver = async () => ['unrelated-value'];
    await expect(verifyDnsClaim('example.com', 'abc123', resolver)).resolves.toBe(false);
  });

  it('returns false rather than throwing when the resolver throws', async () => {
    const resolver: DnsResolver = async () => {
      throw new Error('ENOTFOUND example.com');
    };
    await expect(verifyDnsClaim('example.com', 'abc123', resolver)).resolves.toBe(false);
  });
});

describe('verifyMetaClaim', () => {
  function fakeFetch(html: string) {
    return async (url: string) => ({
      status: 200,
      headers: new Headers(),
      body: new TextEncoder().encode(html),
      finalUrl: url,
      latencyMs: 1,
    });
  }

  it('returns true when a matching meta tag is present', async () => {
    const html = '<html><head><meta name="spotcheck-verification" content="abc123"></head></html>';
    await expect(verifyMetaClaim('example.com', 'abc123', fakeFetch(html))).resolves.toBe(true);
  });

  it('returns true regardless of attribute order', async () => {
    const html = '<meta content="abc123" name="spotcheck-verification">';
    await expect(verifyMetaClaim('example.com', 'abc123', fakeFetch(html))).resolves.toBe(true);
  });

  it('returns false when the token is absent', async () => {
    const html = '<meta name="spotcheck-verification" content="some-other-token">';
    await expect(verifyMetaClaim('example.com', 'abc123', fakeFetch(html))).resolves.toBe(false);
  });

  it('returns false rather than throwing when the fetch throws', async () => {
    const throwingFetch = async () => {
      throw new Error('SsrfError: blocked host');
    };
    await expect(verifyMetaClaim('example.com', 'abc123', throwingFetch)).resolves.toBe(false);
  });
});

describe('verifyEmailClaim', () => {
  it('matches an exact domain, case-insensitively', () => {
    expect(verifyEmailClaim('person@Example.com', 'example.com')).toBe(true);
  });

  it('rejects a non-matching domain', () => {
    expect(verifyEmailClaim('person@other.com', 'example.com')).toBe(false);
  });

  it('accepts a subdomain of the target domain', () => {
    expect(verifyEmailClaim('person@eng.example.com', 'example.com')).toBe(true);
  });
});

describe('applyClaimVerification', () => {
  it('marks the claim verified and transfers the api to the claiming org', async () => {
    const seedOrg = await makeOrg();
    const claimingOrg = await makeOrg();
    const user = await makeUser();
    const api = await makeApi(seedOrg.id);
    const claim = await makeClaim(api.id, user.id);

    const result = await applyClaimVerification(neonDb, {
      claimId: claim.id,
      apiId: api.id,
      orgId: claimingOrg.id,
      createdBy: user.id,
    });
    expect(result).toBe('ok');

    const [updatedClaim] = await db.select().from(schema.claims).where(eq(schema.claims.id, claim.id));
    expect(updatedClaim.status).toBe('verified');

    const [updatedApi] = await db.select().from(schema.apis).where(eq(schema.apis.id, api.id));
    expect(updatedApi.claimStatus).toBe('claimed');
    expect(updatedApi.orgId).toBe(claimingOrg.id);
    expect(updatedApi.createdBy).toBe(user.id);
  });

  it('returns over_limit and leaves rows untouched when the claiming org is already at its plan cap', async () => {
    const seedOrg = await makeOrg();
    const claimingOrg = await makeOrg('free');
    const user = await makeUser();
    const limit = limitsFor('free').maxPersistentApis;
    for (let i = 0; i < limit; i++) {
      await makeApi(claimingOrg.id, { claimStatus: 'claimed' });
    }
    const api = await makeApi(seedOrg.id);
    const claim = await makeClaim(api.id, user.id);

    const result = await applyClaimVerification(neonDb, {
      claimId: claim.id,
      apiId: api.id,
      orgId: claimingOrg.id,
      createdBy: user.id,
    });
    expect(result).toBe('over_limit');

    const [untouchedClaim] = await db.select().from(schema.claims).where(eq(schema.claims.id, claim.id));
    expect(untouchedClaim.status).toBe('pending');

    const [untouchedApi] = await db.select().from(schema.apis).where(eq(schema.apis.id, api.id));
    expect(untouchedApi.claimStatus).toBe('unclaimed');
    expect(untouchedApi.orgId).toBe(seedOrg.id);
  });
});
