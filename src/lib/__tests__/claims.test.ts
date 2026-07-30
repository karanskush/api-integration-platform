import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { applyClaimVerification, verifyDnsClaim, verifyEmailClaim, verifyMetaClaim, type DnsResolver } from '../claims';
import { limitsFor } from '../plans';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
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
      expect(hostname).toBe('_docentapi-verify.example.com');
      return ['unrelated', 'docentapi-verify=abc123'];
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
    const html = '<html><head><meta name="docentapi-verification" content="abc123"></head></html>';
    await expect(verifyMetaClaim('example.com', 'abc123', fakeFetch(html))).resolves.toBe(true);
  });

  it('returns true regardless of attribute order', async () => {
    const html = '<meta content="abc123" name="docentapi-verification">';
    await expect(verifyMetaClaim('example.com', 'abc123', fakeFetch(html))).resolves.toBe(true);
  });

  it('returns false when the token is absent', async () => {
    const html = '<meta name="docentapi-verification" content="some-other-token">';
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

    const result = await applyClaimVerification(db, {
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

    const result = await applyClaimVerification(db, {
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

  // A claim started while the page was unclaimed must not be able to steal
  // the page after somebody else has claimed it.
  it('refuses to transfer an api that is already claimed, leaving the real owner in place', async () => {
    const seedOrg = await makeOrg();
    const realOwner = await makeOrg();
    const attackerOrg = await makeOrg();
    const user = await makeUser();
    const api = await makeApi(seedOrg.id, { claimStatus: 'claimed', orgId: realOwner.id });
    const staleClaim = await makeClaim(api.id, user.id);

    const result = await applyClaimVerification(db, {
      claimId: staleClaim.id,
      apiId: api.id,
      orgId: attackerOrg.id,
      createdBy: user.id,
    });
    expect(result).toBe('already_claimed');

    const [untouchedApi] = await db.select().from(schema.apis).where(eq(schema.apis.id, api.id));
    expect(untouchedApi.orgId).toBe(realOwner.id);

    const [untouchedClaim] = await db.select().from(schema.claims).where(eq(schema.claims.id, staleClaim.id));
    expect(untouchedClaim.status).toBe('pending');
  });

  // Only one of N concurrent verifications may win; the rest must observe the
  // committed transfer rather than overwrite it.
  it('lets exactly one of several concurrent verifications transfer the api', async () => {
    const seedOrg = await makeOrg();
    const user = await makeUser();
    const api = await makeApi(seedOrg.id);
    const contenders = await Promise.all([makeOrg(), makeOrg(), makeOrg()]);
    const claimRows = await Promise.all(contenders.map(() => makeClaim(api.id, user.id)));

    const results = await Promise.all(
      contenders.map((org, i) =>
        applyClaimVerification(db, {
          claimId: claimRows[i].id,
          apiId: api.id,
          orgId: org.id,
          createdBy: user.id,
        }),
      ),
    );

    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'already_claimed')).toHaveLength(2);

    const [finalApi] = await db.select().from(schema.apis).where(eq(schema.apis.id, api.id));
    const winnerIndex = results.indexOf('ok');
    expect(finalApi.orgId).toBe(contenders[winnerIndex].id);
    expect(finalApi.claimStatus).toBe('claimed');
  });

  it('supersedes other pending claims on the page once one succeeds', async () => {
    const seedOrg = await makeOrg();
    const winnerOrg = await makeOrg();
    const winner = await makeUser();
    const other = await makeUser();
    const api = await makeApi(seedOrg.id);
    const winningClaim = await makeClaim(api.id, winner.id);
    const rivalClaim = await makeClaim(api.id, other.id);

    await applyClaimVerification(db, {
      claimId: winningClaim.id,
      apiId: api.id,
      orgId: winnerOrg.id,
      createdBy: winner.id,
    });

    const [rival] = await db.select().from(schema.claims).where(eq(schema.claims.id, rivalClaim.id));
    expect(rival.status).toBe('superseded');
  });

  it('only marks the winning claim verified, never a claim already resolved', async () => {
    const seedOrg = await makeOrg();
    const claimingOrg = await makeOrg();
    const user = await makeUser();
    const api = await makeApi(seedOrg.id);
    const alreadyVerified = await makeClaim(api.id, user.id, { status: 'verified' });

    const result = await applyClaimVerification(db, {
      claimId: alreadyVerified.id,
      apiId: api.id,
      orgId: claimingOrg.id,
      createdBy: user.id,
    });
    // The transfer itself still succeeds (the page was unclaimed), but the
    // status update is guarded on 'pending' so it stays as it was.
    expect(result).toBe('ok');
    const [claim] = await db
      .select()
      .from(schema.claims)
      .where(and(eq(schema.claims.id, alreadyVerified.id), eq(schema.claims.status, 'verified')));
    expect(claim).toBeDefined();
  });
});
