import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import {
  countCredentials,
  deleteCredential,
  listCredentialMeta,
  recentAudit,
  resolveCredential,
  storeCredential,
  writeAudit,
} from '../vaultStore';

const ENV = 'SPOTCHECK_MASTER_KEY';
const original = process.env[ENV];
const SECRET = 'fixture-vault-store-credential-0001';
const ACTOR = { type: 'user' as const, hash: 'actor-hash' };

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

beforeEach(() => {
  process.env[ENV] = Buffer.alloc(32, 11).toString('base64');
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

let seq = 0;
async function seed() {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `Vault Org ${seq}`, slug: `vault-org-${seq}`, plan: 'team' }).returning();
  const [api] = await db
    .insert(schema.apis)
    .values({ orgId: org.id, slug: `vault-api-${seq}`, name: `Vault API ${seq}` })
    .returning();
  return { orgId: org.id, apiId: api.id };
}

async function auditFor(orgId: string) {
  return db
    .select()
    .from(schema.credentialAudit)
    .where(eq(schema.credentialAudit.orgId, orgId))
    .orderBy(desc(schema.credentialAudit.id));
}

describe('storeCredential', () => {
  it('stores an encrypted row with no plaintext anywhere in it', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });

    const [row] = await db.select().from(schema.credentials).where(eq(schema.credentials.apiId, apiId));
    for (const value of Object.values(row)) {
      if (typeof value === 'string') expect(value).not.toContain(SECRET);
    }
    expect(row.encryptedKey.length).toBeGreaterThan(0);
    expect(row.wrappedDek).toContain('.');
    expect(row.keyVersion).toBe(1);
    expect(row.kmsKeyId).toContain('aesgcm-hkdf-v1');
  });

  it('returns metadata that is safe to show, including a hint but not the key', async () => {
    const { orgId, apiId } = await seed();
    const meta = await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });
    expect(meta.hint).toBe(`••••${SECRET.slice(-4)}`);
    expect(JSON.stringify(meta)).not.toContain(SECRET);
  });

  it('audits the creation', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });
    const [entry] = await auditFor(orgId);
    expect(entry.action).toBe('created');
    expect(entry.actorType).toBe('user');
    expect(entry.detail).toBe('key_version=1');
  });

  // The unique (api_id, environment) index is what makes this a rotation rather
  // than a second shadow row the MCP path would pick between arbitrarily.
  it('replaces an existing credential for the same environment and bumps the key version', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });
    const second = await storeCredential(db, { orgId, apiId, environment: 'production', secret: 'fixture-rotated-credential-0002', actor: ACTOR });

    const rows = await db.select().from(schema.credentials).where(eq(schema.credentials.apiId, apiId));
    expect(rows).toHaveLength(1);
    expect(second.keyVersion).toBe(2);
    expect(rows[0].rotatedAt).not.toBeNull();
  });

  it('audits a replacement as a rotation, not a creation', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: 'another', actor: ACTOR });
    const entries = await auditFor(orgId);
    expect(entries[0].action).toBe('rotated');
    expect(entries[1].action).toBe('created');
  });

  it('keeps production and sandbox credentials side by side', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: 'prod-key-value', actor: ACTOR });
    await storeCredential(db, { orgId, apiId, environment: 'sandbox', secret: 'sandbox-key-value', actor: ACTOR });

    const meta = await listCredentialMeta(db, apiId);
    expect(meta.map((m) => m.environment).sort()).toEqual(['production', 'sandbox']);
  });
});

describe('resolveCredential', () => {
  it('returns the decrypted secret for the right context', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });

    const result = await resolveCredential(db, { orgId, apiId, environment: 'production', actor: { type: 'mcp' } });
    expect(result).toMatchObject({ ok: true, secret: SECRET });
  });

  it('reports not_found rather than throwing when nothing is stored', async () => {
    const { orgId, apiId } = await seed();
    expect(await resolveCredential(db, { orgId, apiId, environment: 'production', actor: { type: 'mcp' } })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('does not cross environments', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'sandbox', secret: SECRET, actor: ACTOR });
    expect((await resolveCredential(db, { orgId, apiId, environment: 'production', actor: { type: 'mcp' } })).ok).toBe(false);
  });

  it('audits every use, with the caller type', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });
    await resolveCredential(db, { orgId, apiId, environment: 'production', actor: { type: 'mcp', hash: 'token-hash' } });

    const [entry] = await auditFor(orgId);
    expect(entry.action).toBe('used');
    expect(entry.actorType).toBe('mcp');
    expect(entry.actorHash).toBe('token-hash');
  });

  it('records lastUsedAt so an unused credential is visible as such', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });
    expect((await listCredentialMeta(db, apiId))[0].lastUsedAt).toBeNull();

    await resolveCredential(db, { orgId, apiId, environment: 'production', actor: { type: 'mcp' } });
    expect((await listCredentialMeta(db, apiId))[0].lastUsedAt).not.toBeNull();
  });

  // A failed decrypt is at least as interesting as a successful one: it means
  // tampering, a rotated master key, or corruption.
  it('audits a failed decrypt and leaks nothing to the caller', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });

    process.env[ENV] = Buffer.alloc(32, 12).toString('base64'); // master key rotated out from under it
    const result = await resolveCredential(db, { orgId, apiId, environment: 'production', actor: { type: 'mcp' } });

    expect(result).toEqual({ ok: false, reason: 'decrypt_failed' });
    const [entry] = await auditFor(orgId);
    expect(entry.action).toBe('decrypt_failed');
    expect(entry.detail).not.toContain(SECRET);
  });

  it('refuses a row whose api_id was tampered with in the database', async () => {
    const { orgId, apiId } = await seed();
    const other = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });

    // Simulate an attacker repointing the row at an API they control.
    await db.update(schema.credentials).set({ apiId: other.apiId }).where(eq(schema.credentials.apiId, apiId));

    const result = await resolveCredential(db, {
      orgId: other.orgId,
      apiId: other.apiId,
      environment: 'production',
      actor: { type: 'mcp' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('deleteCredential', () => {
  it('removes the row and reports success', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });

    expect(await deleteCredential(db, { orgId, apiId, environment: 'production', actor: ACTOR })).toBe(true);
    expect(await listCredentialMeta(db, apiId)).toHaveLength(0);
  });

  it('reports false for a credential that was never there', async () => {
    const { orgId, apiId } = await seed();
    expect(await deleteCredential(db, { orgId, apiId, environment: 'production', actor: ACTOR })).toBe(false);
  });

  // The row is gone, so the audit FK nulls — the id has to survive in detail or
  // the trail for a deleted credential becomes unfollowable.
  it('keeps the deleted credential id in the audit trail', async () => {
    const { orgId, apiId } = await seed();
    const stored = await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });
    await deleteCredential(db, { orgId, apiId, environment: 'production', actor: ACTOR });

    const [entry] = await auditFor(orgId);
    expect(entry.action).toBe('deleted');
    expect(entry.detail).toContain(stored.id);
  });

  it('only deletes the requested environment', async () => {
    const { orgId, apiId } = await seed();
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: 'prod-key-value', actor: ACTOR });
    await storeCredential(db, { orgId, apiId, environment: 'sandbox', secret: 'sandbox-key-value', actor: ACTOR });

    await deleteCredential(db, { orgId, apiId, environment: 'sandbox', actor: ACTOR });
    expect((await listCredentialMeta(db, apiId)).map((m) => m.environment)).toEqual(['production']);
  });
});

describe('audit surface', () => {
  it('records a denied attempt even though nothing was stored', async () => {
    const { orgId, apiId } = await seed();
    await writeAudit(db, { orgId, apiId, action: 'denied', actor: ACTOR, detail: 'plan=free' });
    const [entry] = await auditFor(orgId);
    expect(entry.action).toBe('denied');
    expect(entry.credentialId).toBeNull();
  });

  // Ordering must hold even for entries written inside the same millisecond,
  // which is why recentAudit orders by the monotonic id and not created_at.
  it('returns recent entries newest first, scoped to the org', async () => {
    const a = await seed();
    const b = await seed();
    await writeAudit(db, { orgId: a.orgId, action: 'created', actor: ACTOR, detail: 'first' });
    await writeAudit(db, { orgId: a.orgId, action: 'used', actor: ACTOR, detail: 'second' });
    await writeAudit(db, { orgId: b.orgId, action: 'used', actor: ACTOR, detail: 'other org' });

    const entries = await recentAudit(db, a.orgId);
    expect(entries.map((e) => e.detail)).toEqual(['second', 'first']);
    expect(entries.map((e) => e.detail)).not.toContain('other org');
  });

  it('preserves insertion order across a burst written in the same millisecond', async () => {
    const { orgId } = await seed();
    for (let i = 0; i < 12; i++) {
      await writeAudit(db, { orgId, action: 'used', actor: ACTOR, detail: `entry-${i}` });
    }
    const entries = await recentAudit(db, orgId);
    expect(entries.map((e) => e.detail)).toEqual(
      Array.from({ length: 12 }, (_, i) => `entry-${11 - i}`),
    );
  });

  it('clamps the requested limit', async () => {
    const { orgId } = await seed();
    await writeAudit(db, { orgId, action: 'used', actor: ACTOR });
    expect((await recentAudit(db, orgId, 0)).length).toBeLessThanOrEqual(1);
    expect((await recentAudit(db, orgId, 100_000)).length).toBeLessThanOrEqual(500);
  });
});

describe('countCredentials', () => {
  it('counts per org', async () => {
    const { orgId, apiId } = await seed();
    expect(await countCredentials(db, orgId)).toBe(0);
    await storeCredential(db, { orgId, apiId, environment: 'production', secret: SECRET, actor: ACTOR });
    expect(await countCredentials(db, orgId)).toBe(1);
  });
});
