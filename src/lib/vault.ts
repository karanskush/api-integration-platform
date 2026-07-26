// Envelope encryption for vaulted upstream credentials (Team+).
//
// TECH_IMPLEMENTATION.md §5 requires: per-org data keys, plaintext never at
// rest, decrypt only inside the MCP/probe execution path, audit-logged on every
// use, and never in application logs. This module owns the first three.
//
// Two layers, which is what "envelope" means here:
//
//   plaintext  --AES-256-GCM(DEK)-->  ciphertext        (stored)
//   DEK        --AES-256-GCM(KEK)-->  wrapped DEK       (stored)
//   KEK        = HKDF(master, 'credential-wrap', org:version)   (never stored)
//
// A fresh random DEK per credential means two credentials never share key
// material, and re-wrapping during rotation touches only the small wrapped-DEK
// blob rather than re-encrypting every secret.
//
// AAD binds every ciphertext to its (org, api, environment, version) context.
// Without it, a database-level attacker who could move a row between APIs — or
// swap two orgs' rows — would get a valid decryption under the destination's
// key path. With it, that tampering fails authentication instead.
//
// Nothing here logs, throws, or serializes plaintext: VaultError messages are
// deliberately contentless, because an error string is the classic way a secret
// escapes into a log aggregator.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey, hmacHex, secretsEqual } from './keys';

export const VAULT_SCHEME = 'aesgcm-hkdf-v1';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const DEK_BYTES = 32;
const MAX_SECRET_BYTES = 8 * 1024; // an API key, not a file

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export type CredentialContext = {
  orgId: string;
  apiId: string;
  environment: string;
  keyVersion: number;
};

export type SealedCredential = {
  scheme: typeof VAULT_SCHEME;
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  wrappedDek: string; // base64 of iv|tag|ciphertext
  keyVersion: number;
};

// The identity of the key-wrapping scheme, recorded per row so a future move to
// a real KMS can be rolled out incrementally: rows carry which scheme sealed
// them, rather than the code assuming all rows use today's.
export function kekId(ctx: CredentialContext): string {
  return `${VAULT_SCHEME}:org=${ctx.orgId}:v=${ctx.keyVersion}`;
}

// Any change to this string invalidates every ciphertext bound by it, which is
// exactly the intent — a row must not decrypt outside the context it was
// sealed in.
function aad(ctx: CredentialContext): Buffer {
  return Buffer.from(`${VAULT_SCHEME}|${ctx.orgId}|${ctx.apiId}|${ctx.environment}|${ctx.keyVersion}`, 'utf8');
}

function kek(ctx: CredentialContext): Buffer {
  return deriveKey('credential-wrap', `${ctx.orgId}:${ctx.keyVersion}`);
}

function encrypt(key: Buffer, plaintext: Buffer, additional: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(additional);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, iv: Buffer, ciphertext: Buffer, authTag: Buffer, additional: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(additional);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function packWrapped(iv: Buffer, authTag: Buffer, ciphertext: Buffer): string {
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`;
}

function unpackWrapped(packed: string): { iv: Buffer; authTag: Buffer; ciphertext: Buffer } {
  const parts = packed.split('.');
  if (parts.length !== 3) throw new VaultError('Stored credential is malformed');
  const [iv, authTag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64'));
  if (iv.length !== IV_BYTES || authTag.length !== 16 || ciphertext.length !== DEK_BYTES) {
    throw new VaultError('Stored credential is malformed');
  }
  return { iv, authTag, ciphertext };
}

export function sealCredential(secret: string, ctx: CredentialContext): SealedCredential {
  if (!secret) throw new VaultError('Credential is empty');
  const plaintext = Buffer.from(secret, 'utf8');
  if (plaintext.byteLength > MAX_SECRET_BYTES) {
    throw new VaultError(`Credential exceeds ${MAX_SECRET_BYTES} bytes`);
  }

  const additional = aad(ctx);
  const dek = randomBytes(DEK_BYTES);
  try {
    const sealed = encrypt(dek, plaintext, additional);
    const wrapped = encrypt(kek(ctx), dek, additional);
    return {
      scheme: VAULT_SCHEME,
      ciphertext: sealed.ciphertext.toString('base64'),
      iv: sealed.iv.toString('base64'),
      authTag: sealed.authTag.toString('base64'),
      wrappedDek: packWrapped(wrapped.iv, wrapped.authTag, wrapped.ciphertext),
      keyVersion: ctx.keyVersion,
    };
  } finally {
    // Best-effort hygiene: drop the DEK bytes rather than leaving them for the
    // GC to hand out in a later allocation.
    dek.fill(0);
    plaintext.fill(0);
  }
}

export function openCredential(sealed: SealedCredential, ctx: CredentialContext): string {
  if (sealed.scheme !== VAULT_SCHEME) {
    throw new VaultError(`Unsupported credential scheme`);
  }
  if (sealed.keyVersion !== ctx.keyVersion) {
    throw new VaultError('Credential key version mismatch');
  }

  const additional = aad(ctx);
  let dek: Buffer | null = null;
  try {
    const wrapped = unpackWrapped(sealed.wrappedDek);
    dek = decrypt(kek(ctx), wrapped.iv, wrapped.ciphertext, wrapped.authTag, additional);
    const plaintext = decrypt(
      dek,
      Buffer.from(sealed.iv, 'base64'),
      Buffer.from(sealed.ciphertext, 'base64'),
      Buffer.from(sealed.authTag, 'base64'),
      additional,
    );
    return plaintext.toString('utf8');
  } catch (err) {
    if (err instanceof VaultError) throw err;
    // GCM authentication failure, wrong key path, or tampered row. The
    // underlying message is never surfaced: it varies by failure mode and is
    // therefore an oracle.
    throw new VaultError('Credential could not be decrypted');
  } finally {
    dek?.fill(0);
  }
}

// Rotation without re-reading plaintext is impossible with authenticated
// encryption (the DEK is itself bound to the old context), so this decrypts and
// re-seals under the next version. Kept here so the plaintext never leaves this
// module during a rotation.
export function rotateCredential(sealed: SealedCredential, ctx: CredentialContext): SealedCredential {
  const plaintext = openCredential(sealed, ctx);
  try {
    return sealCredential(plaintext, { ...ctx, keyVersion: ctx.keyVersion + 1 });
  } finally {
    // Strings are immutable in JS so this cannot be wiped; noted rather than
    // pretended otherwise. Scope is one function call.
  }
}

// A stable, non-reversible fingerprint for display and for detecting "is this
// the same key I already stored?" without ever revealing the key. Derived
// through HKDF so it is not a bare hash an attacker could rainbow-table against
// a guessed key format.
export function credentialFingerprint(secret: string, ctx: CredentialContext): string {
  return hmacHex(deriveKey('credential-fingerprint', ctx.orgId), secret).slice(0, 32);
}

export function fingerprintsMatch(a: string, b: string): boolean {
  return secretsEqual(a, b);
}

// Last 4 characters only, and only when the secret is long enough that 4
// characters cannot meaningfully narrow it down.
export function credentialHint(secret: string): string {
  return secret.length >= 12 ? `••••${secret.slice(-4)}` : '••••';
}
