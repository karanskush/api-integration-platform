// Which key a probe run uses, and therefore which environment its facts carry.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { selectProbeAuth } from '../probeCredential';
import { storeCredential } from '../vaultStore';

const ENV = 'DOCENTAPI_MASTER_KEY';
const original = process.env[ENV];
const SANDBOX_SECRET = 'fixture-sandbox-credential-0001';
const PRODUCTION_SECRET = 'fixture-production-credential-0001';
const ACTOR = { type: 'user' as const, hash: 'h' };

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);
beforeEach(() => {
  process.env[ENV] = Buffer.alloc(32, 13).toString('base64');
});
afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

let seq = 0;
async function seed(plan: string) {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `PA Org ${seq}`, slug: `pa-org-${seq}`, plan }).returning();
  const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: `pa-api-${seq}`, name: `PA API ${seq}` }).returning();
  return { orgId: org.id, apiId: api.id, plan };
}

describe('selectProbeAuth', () => {
  it('uses a pasted key first, in the environment the caller declared', async () => {
    const s = await seed('free');
    const auth = await selectProbeAuth(db, { ...s, actor: { type: 'probe' }, byok: { key: 'pasted', environment: 'sandbox' } });
    expect(auth).toMatchObject({ kind: 'byok', upstreamKey: 'pasted', environment: 'sandbox', credentialId: null });
  });

  it('falls back to the sandbox vault on a Free plan', async () => {
    const s = await seed('free');
    await storeCredential(db, { ...s, environment: 'sandbox', secret: SANDBOX_SECRET, actor: ACTOR, label: 'test ws' });
    const auth = await selectProbeAuth(db, { ...s, actor: { type: 'probe' } });
    expect(auth).toMatchObject({ kind: 'vault', upstreamKey: SANDBOX_SECRET, environment: 'sandbox', label: 'test ws' });
    expect(auth.credentialId).toBeTruthy();
  });

  it('prefers the production vault on Team, and still falls back to sandbox', async () => {
    const both = await seed('team');
    await storeCredential(db, { ...both, environment: 'production', secret: PRODUCTION_SECRET, actor: ACTOR });
    await storeCredential(db, { ...both, environment: 'sandbox', secret: SANDBOX_SECRET, actor: ACTOR });
    expect(await selectProbeAuth(db, { ...both, actor: { type: 'cron' } })).toMatchObject({ kind: 'vault', environment: 'production', upstreamKey: PRODUCTION_SECRET });

    const onlySandbox = await seed('team');
    await storeCredential(db, { ...onlySandbox, environment: 'sandbox', secret: SANDBOX_SECRET, actor: ACTOR });
    expect(await selectProbeAuth(db, { ...onlySandbox, actor: { type: 'cron' } })).toMatchObject({ kind: 'vault', environment: 'sandbox' });
  });

  it('never resolves a production credential for a plan without vaultedCredentials', async () => {
    const s = await seed('free');
    // Stored directly: the route would refuse this on Free, but the selector must not depend on that.
    await storeCredential(db, { ...s, environment: 'production', secret: PRODUCTION_SECRET, actor: ACTOR });
    const auth = await selectProbeAuth(db, { ...s, actor: { type: 'cron' } });
    expect(auth.kind).toBe('none');
    expect(auth.environment).toBe('production');
  });

  it('answers none, production, when nothing is stored', async () => {
    const s = await seed('business');
    expect(await selectProbeAuth(db, { ...s, actor: { type: 'cron' } })).toMatchObject({ kind: 'none', upstreamKey: undefined, environment: 'production' });
  });

  it('never serialises the key', async () => {
    const s = await seed('free');
    await storeCredential(db, { ...s, environment: 'sandbox', secret: SANDBOX_SECRET, actor: ACTOR });
    const auth = await selectProbeAuth(db, { ...s, actor: { type: 'probe' } });
    const { upstreamKey: _k, ...rest } = auth;
    expect(JSON.stringify(rest)).not.toContain(SANDBOX_SECRET);
  });
});
