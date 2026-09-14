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
import { can } from './plans';
import { kekId, openCredential, sealCredential, credentialFingerprint, credentialHint, VaultError, type CredentialContext, type SealedCredential } from './vault';

export type CredentialEnvironment = 'production' | 'sandbox';
export const CREDENTIAL_ENVIRONMENTS: readonly CredentialEnvironment[] = ['production', 'sandbox'];

// Which plan flag governs storing a credential for an environment. A sandbox
// key is on every plan (`sandboxProbing`); a production key stays Team+
// (`vaultedCredentials`). Pure, so the route stays thin and this is testable.
export function credentialGate(plan: string, environment: CredentialEnvironment): { ok: true } | { ok: false; error: string; status: 403 } {
  if (environment === 'sandbox') {
    return can(plan, 'sandboxProbing')
      ? { ok: true }
      : { ok: false, status: 403, error: 'Sandbox credentials are not available on this plan.' };
  }
  return can(plan, 'vaultedCredentials')
    ? { ok: true }
    : {
        ok: false,
        status: 403,
        error: 'Storing a production credential is a Team plan feature — store a sandbox key instead, or keep passing your key per request (BYOK).',
      };
}

export type EnvironmentInferenceRecord = { environment: 'sandbox' | 'production' | 'unknown'; basis: 'known_prefix' | 'declared_prefix' | 'host' | 'none' };

export type AuditAction = 'created' | 'rotated' | 'deleted' | 'used' | 'denied' | 'decrypt_failed' | 'consent_changed';
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
  label?: string | null;
  // Consents are honoured only for a sandbox row; the database CHECK refuses
  // them on production, and storeCredential drops them rather than trip it.
  writeConsent?: boolean;
  burstConsent?: boolean;
  consentedBy?: string | null;
  inferred?: EnvironmentInferenceRecord | null;
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
  label: string | null;
  writeConsentAt: Date | null;
  burstConsentAt: Date | null;
  inferredEnvironment: string | null;
  inferenceBasis: string | null;
  lastProbeRunAt: Date | null;
};

const META_COLUMNS = {
  id: credentials.id,
  environment: credentials.environment,
  fingerprint: credentials.fingerprint,
  hint: credentials.hint,
  keyVersion: credentials.keyVersion,
  createdAt: credentials.createdAt,
  rotatedAt: credentials.rotatedAt,
  lastUsedAt: credentials.lastUsedAt,
  label: credentials.label,
  writeConsentAt: credentials.writeConsentAt,
  burstConsentAt: credentials.burstConsentAt,
  inferredEnvironment: credentials.inferredEnvironment,
  inferenceBasis: credentials.inferenceBasis,
  lastProbeRunAt: credentials.lastProbeRunAt,
};

function consentDetail(row: { writeConsentAt: Date | null; burstConsentAt: Date | null }): string {
  return `write_consent=${row.writeConsentAt ? 1 : 0} burst_consent=${row.burstConsentAt ? 1 : 0}`;
}

// Upsert on (apiId, environment) — the unique index makes "store" idempotent
// per environment rather than accumulating shadow rows. Replacing an existing
// credential is a rotation, and is audited as one.
export async function storeCredential(db: Db, input: StoreCredentialInput): Promise<StoredCredentialMeta> {
  const { orgId, apiId, environment, secret, createdBy, actor } = input;
  const sandbox = environment === 'sandbox';
  const now = new Date();

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
    ...(existing ? { rotatedAt: now } : {}),
    label: input.label ?? null,
    writeConsentAt: sandbox && input.writeConsent ? now : null,
    writeConsentedBy: sandbox && input.writeConsent ? (input.consentedBy ?? null) : null,
    burstConsentAt: sandbox && input.burstConsent ? now : null,
    burstConsentedBy: sandbox && input.burstConsent ? (input.consentedBy ?? null) : null,
    inferredEnvironment: input.inferred?.environment ?? null,
    inferenceBasis: input.inferred?.basis ?? null,
  };

  const [row] = await db
    .insert(credentials)
    .values(values)
    .onConflictDoUpdate({ target: [credentials.apiId, credentials.environment], set: values })
    .returning(META_COLUMNS);

  await writeAudit(db, {
    orgId,
    apiId,
    credentialId: row.id,
    environment,
    action: existing ? 'rotated' : 'created',
    actor,
    detail: `key_version=${sealed.keyVersion} ${consentDetail(row)}`,
  });

  return row;
}

export async function listCredentialMeta(db: Db, apiId: string): Promise<StoredCredentialMeta[]> {
  return db.select(META_COLUMNS).from(credentials).where(eq(credentials.apiId, apiId));
}

export type ConsentUpdateInput = {
  orgId: string;
  apiId: string;
  label?: string | null;
  writeConsent?: boolean;
  burstConsent?: boolean;
  consentedBy?: string | null;
  actor: Actor;
};

/**
 * Changes what the owner allows the probes to do with the SANDBOX key: the
 * label, write consent, burst consent. Production rows have no consents to
 * change (the CHECK would refuse), so this always addresses the sandbox row.
 * Returns null when there is no sandbox credential to update.
 */
export async function updateCredentialConsents(db: Db, input: ConsentUpdateInput): Promise<StoredCredentialMeta | null> {
  const now = new Date();
  const set: Partial<typeof credentials.$inferInsert> = {};
  if (input.label !== undefined) set.label = input.label;
  if (input.writeConsent !== undefined) {
    set.writeConsentAt = input.writeConsent ? now : null;
    set.writeConsentedBy = input.writeConsent ? (input.consentedBy ?? null) : null;
  }
  if (input.burstConsent !== undefined) {
    set.burstConsentAt = input.burstConsent ? now : null;
    set.burstConsentedBy = input.burstConsent ? (input.consentedBy ?? null) : null;
  }
  if (Object.keys(set).length === 0) {
    const [current] = await db
      .select(META_COLUMNS)
      .from(credentials)
      .where(and(eq(credentials.apiId, input.apiId), eq(credentials.environment, 'sandbox')))
      .limit(1);
    return current ?? null;
  }

  const [row] = await db
    .update(credentials)
    .set(set)
    .where(and(eq(credentials.apiId, input.apiId), eq(credentials.environment, 'sandbox')))
    .returning(META_COLUMNS);
  if (!row) return null;

  await writeAudit(db, {
    orgId: input.orgId,
    apiId: input.apiId,
    credentialId: row.id,
    environment: 'sandbox',
    action: 'consent_changed',
    actor: input.actor,
    detail: consentDetail(row),
  });
  return row;
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

export type ProbeResolveResult =
  | {
      ok: true;
      secret: string;
      credentialId: string;
      environment: CredentialEnvironment;
      label: string | null;
      writeConsentAt: Date | null;
      burstConsentAt: Date | null;
    }
  | { ok: false; reason: 'not_found' | 'decrypt_failed' | 'no_write_consent' };

/**
 * THE function a probe runner calls for a key. Wraps resolveCredential with the
 * consent check a write runner needs, records the probe use on the row, and
 * audits a refusal — so "the runner wanted to write and was not allowed" is a
 * row in the trail, not a silent skip. Callers pass actor type 'probe' so
 * probe traffic is distinguishable from cron reads and MCP calls in the audit.
 */
export async function resolveProbeCredential(
  db: Db,
  input: {
    orgId: string;
    apiId: string;
    environment: CredentialEnvironment;
    actor: Actor;
    requireWriteConsent?: boolean;
  },
): Promise<ProbeResolveResult> {
  const [row] = await db
    .select({
      id: credentials.id,
      label: credentials.label,
      writeConsentAt: credentials.writeConsentAt,
      burstConsentAt: credentials.burstConsentAt,
    })
    .from(credentials)
    .where(and(eq(credentials.apiId, input.apiId), eq(credentials.environment, input.environment)))
    .limit(1);
  if (!row) return { ok: false, reason: 'not_found' };

  if (input.requireWriteConsent && !row.writeConsentAt) {
    await writeAudit(db, {
      orgId: input.orgId,
      apiId: input.apiId,
      credentialId: row.id,
      environment: input.environment,
      action: 'denied',
      actor: input.actor,
      detail: 'reason=no_write_consent',
    });
    return { ok: false, reason: 'no_write_consent' };
  }

  const resolved = await resolveCredential(db, {
    orgId: input.orgId,
    apiId: input.apiId,
    environment: input.environment,
    actor: input.actor,
  });
  if (!resolved.ok) return resolved;

  await db.update(credentials).set({ lastProbeRunAt: new Date() }).where(eq(credentials.id, row.id));
  return {
    ok: true,
    secret: resolved.secret,
    credentialId: resolved.credentialId,
    environment: input.environment,
    label: row.label,
    writeConsentAt: row.writeConsentAt,
    burstConsentAt: row.burstConsentAt,
  };
}

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

/** The trail for one API — what the owner sees beside the credential panel. */
export async function recentAuditForApi(db: Db, orgId: string, apiId: string, limit = 20) {
  return db
    .select({
      id: credentialAudit.id,
      action: credentialAudit.action,
      actorType: credentialAudit.actorType,
      environment: credentialAudit.environment,
      detail: credentialAudit.detail,
      createdAt: credentialAudit.createdAt,
    })
    .from(credentialAudit)
    .where(and(eq(credentialAudit.orgId, orgId), eq(credentialAudit.apiId, apiId)))
    .orderBy(desc(credentialAudit.id))
    .limit(Math.max(1, Math.min(100, limit)));
}

export async function countCredentials(db: Db, orgId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(credentials)
    .where(eq(credentials.orgId, orgId));
  return count;
}
