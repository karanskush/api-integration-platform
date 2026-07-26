// Persistence + audit for vaulted credentials. vault.ts owns the crypto; this
// owns the rows and the trail.
//
// The rule this module enforces: every read of a credential writes an audit
// entry, including the reads that fail. A vault whose successful decrypts are
// logged but whose *denied* and *failed* ones are not is a vault you cannot
// investigate — a brute-force attempt looks like silence.

import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { credentialAudit, credentials } from './db/schema';
import { kekId, openCredential, sealCredential, credentialFingerprint, credentialHint, VaultError, type CredentialContext, type SealedCredential } from './vault';

export type AuditAction = 'created' | 'rotated' | 'deleted' | 'used' | 'denied' | 'decrypt_failed';
export type ActorType = 'user' | 'mcp' | 'probe' | 'cron';

export type Actor = { type: ActorType; hash?: string };

export type AuditInput = {
  orgId: string;
  apiId?: string | null;
  credentialId?: string | null;
  environment?: string | null;
  action: AuditAction;
  actor: Actor;
  detail?: string;
};

// Never throws: an audit write that fails must not take the request with it,
// but it must be visible in the server log so the gap is discoverable.
export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  try {
    await db.insert(credentialAudit).values({
      orgId: input.orgId,
      apiId: input.apiId ?? null,
      credentialId: input.credentialId ?? null,
      environment: input.environment ?? null,
      action: input.action,
      actorType: input.actor.type,
      actorHash: input.actor.hash ?? null,
      detail: input.detail ?? null,
    });
  } catch (err) {
    console.error('[vault] audit write failed', {
      action: input.action,
      orgId: input.orgId,
      // The error message only — never the input payload, which carries ids.
      reason: err instanceof Error ? err.name : 'unknown',
    });
  }
}

export type StoreCredentialInput = {
  orgId: string;
  apiId: string;
  environment: string;
  secret: string;
  createdBy?: string;
  actor: Actor;
};

export type StoredCredentialMeta = {
  id: string;
  environment: string;
  fingerprint: string;
  hint: string;
  keyVersion: number;
  createdAt: Date;
  rotatedAt: Date | null;
  lastUsedAt: Date | null;
};

// Upsert on (apiId, environment) — the unique index makes "store" idempotent
// per environment rather than accumulating shadow rows. Replacing an existing
// credential is a rotation, and is audited as one.
export async function storeCredential(db: Db, input: StoreCredentialInput): Promise<StoredCredentialMeta> {
  const { orgId, apiId, environment, secret, createdBy, actor } = input;

  const [existing] = await db
    .select({ id: credentials.id, keyVersion: credentials.keyVersion })
    .from(credentials)
    .where(and(eq(credentials.apiId, apiId), eq(credentials.environment, environment)))
    .limit(1);

  const keyVersion = existing ? existing.keyVersion + 1 : 1;
  const ctx: CredentialContext = { orgId, apiId, environment, keyVersion };
  const sealed = sealCredential(secret, ctx);

  const values = {
    orgId,
    apiId,
    environment,
    encryptedKey: sealed.ciphertext,
    iv: sealed.iv,
    authTag: sealed.authTag,
    wrappedDek: sealed.wrappedDek,
    keyVersion: sealed.keyVersion,
    kmsKeyId: kekId(ctx),
    fingerprint: credentialFingerprint(secret, ctx),
    hint: credentialHint(secret),
    createdBy: createdBy ?? null,
    ...(existing ? { rotatedAt: new Date() } : {}),
  };

  const [row] = await db
    .insert(credentials)
    .values(values)
    .onConflictDoUpdate({ target: [credentials.apiId, credentials.environment], set: values })
    .returning({
      id: credentials.id,
      environment: credentials.environment,
      fingerprint: credentials.fingerprint,
      hint: credentials.hint,
      keyVersion: credentials.keyVersion,
      createdAt: credentials.createdAt,
      rotatedAt: credentials.rotatedAt,
      lastUsedAt: credentials.lastUsedAt,
    });

  await writeAudit(db, {
    orgId,
    apiId,
    credentialId: row.id,
    environment,
    action: existing ? 'rotated' : 'created',
    actor,
    detail: `key_version=${sealed.keyVersion}`,
  });

  return row;
}

export async function listCredentialMeta(db: Db, apiId: string): Promise<StoredCredentialMeta[]> {
  return db
    .select({
      id: credentials.id,
      environment: credentials.environment,
      fingerprint: credentials.fingerprint,
      hint: credentials.hint,
      keyVersion: credentials.keyVersion,
      createdAt: credentials.createdAt,
      rotatedAt: credentials.rotatedAt,
      lastUsedAt: credentials.lastUsedAt,
    })
    .from(credentials)
    .where(eq(credentials.apiId, apiId));
}

export async function deleteCredential(
  db: Db,
  input: { orgId: string; apiId: string; environment: string; actor: Actor },
): Promise<boolean> {
  const deleted = await db
    .delete(credentials)
    .where(and(eq(credentials.apiId, input.apiId), eq(credentials.environment, input.environment)))
    .returning({ id: credentials.id });

  if (!deleted.length) return false;

  await writeAudit(db, {
    orgId: input.orgId,
    apiId: input.apiId,
    // The row is gone, so the FK is nulled; the id lives on in `detail` so the
    // trail for a deleted credential is still followable.
    credentialId: null,
    environment: input.environment,
    action: 'deleted',
    actor: input.actor,
    detail: `credential_id=${deleted[0].id}`,
  });
  return true;
}

export type ResolveResult =
  | { ok: true; secret: string; credentialId: string }
  | { ok: false; reason: 'not_found' | 'decrypt_failed' };

// THE ONLY PLACE a vaulted credential is decrypted. Callers must already have
// established that the requester is authorized (see mcpAccess.ts) and that the
// org's plan permits vaulted credentials — this function deliberately does not
// re-check either, so that the authorization decision stays in one place at the
// call site rather than being half-enforced in two.
export async function resolveCredential(
  db: Db,
  input: { orgId: string; apiId: string; environment: string; actor: Actor },
): Promise<ResolveResult> {
  const { orgId, apiId, environment, actor } = input;

  const [row] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.apiId, apiId), eq(credentials.environment, environment)))
    .limit(1);

  if (!row) return { ok: false, reason: 'not_found' };

  const sealed: SealedCredential = {
    scheme: 'aesgcm-hkdf-v1',
    ciphertext: row.encryptedKey,
    iv: row.iv,
    authTag: row.authTag,
    wrappedDek: row.wrappedDek,
    keyVersion: row.keyVersion,
  };

  try {
    const secret = openCredential(sealed, { orgId: row.orgId, apiId: row.apiId, environment: row.environment, keyVersion: row.keyVersion });

    // Usage bookkeeping and the audit entry are both best-effort relative to
    // returning the secret: the caller already holds it, so failing here would
    // lose the credential's usefulness without improving the record.
    await db.update(credentials).set({ lastUsedAt: new Date() }).where(eq(credentials.id, row.id));
    await writeAudit(db, {
      orgId,
      apiId,
      credentialId: row.id,
      environment,
      action: 'used',
      actor,
      detail: `key_version=${row.keyVersion}`,
    });

    return { ok: true, secret, credentialId: row.id };
  } catch (err) {
    // A failed decrypt means tampering, a rotated master key, or a corrupted
    // row — all worth an alert, none worth telling the caller which.
    await writeAudit(db, {
      orgId,
      apiId,
      credentialId: row.id,
      environment,
      action: 'decrypt_failed',
      actor,
      detail: err instanceof VaultError ? err.message : 'unknown',
    });
    console.error('[vault] decrypt failed', { apiId, environment, keyVersion: row.keyVersion });
    return { ok: false, reason: 'decrypt_failed' };
  }
}

// Ordered by id, not created_at. created_at has millisecond resolution, so two
// entries written in the same tick tie and the order becomes arbitrary — which
// in an audit trail is worse than useless, because "created then used" and
// "used then created" mean very different things. bigserial is monotonic, and
// for an append-only log insertion order IS chronological order.
export async function recentAudit(db: Db, orgId: string, limit = 100) {
  return db
    .select({
      id: credentialAudit.id,
      action: credentialAudit.action,
      actorType: credentialAudit.actorType,
      actorHash: credentialAudit.actorHash,
      apiId: credentialAudit.apiId,
      environment: credentialAudit.environment,
      detail: credentialAudit.detail,
      createdAt: credentialAudit.createdAt,
    })
    .from(credentialAudit)
    .where(eq(credentialAudit.orgId, orgId))
    .orderBy(desc(credentialAudit.id))
    .limit(Math.max(1, Math.min(500, limit)));
}

export async function countCredentials(db: Db, orgId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(credentials)
    .where(eq(credentials.orgId, orgId));
  return count;
}
