// One master secret, many purpose-scoped subkeys.
//
// Two features need cryptographic key material: CI sync tokens (ciSync.ts) and
// the credential vault (vault.ts). Giving each its own env var means two
// secrets to provision and rotate, and invites reuse of the same bytes for
// both. Instead a single SPOTCHECK_MASTER_KEY is expanded with HKDF into
// domain-separated subkeys, so a subkey leak cannot be walked back to the
// master or sideways into another purpose.
//
// Provisioning:
//   openssl rand -base64 32   -> SPOTCHECK_MASTER_KEY
//
// Rotation: the master key is the root of trust for issued CI tokens and
// wrapped credential keys, so rotating it invalidates both. Per-object
// versioning (apis.ci_token_version, credentials.key_version) exists so a
// single API or credential can be rotated without touching the master.
//
// Upgrade path to a real KMS: deriveKey() is the only place key material is
// produced. Swapping HKDF-over-env for an AWS KMS GenerateDataKey call is a
// change to this one function; nothing above it holds raw key bytes.

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const ENV_VAR = 'SPOTCHECK_MASTER_KEY';
const MIN_KEY_BYTES = 32;

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

// Accepts base64, base64url, or hex — whichever the operator's key generator
// produced — and insists on at least 256 bits of material either way.
function parseKeyMaterial(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) throw new MasterKeyError(`${ENV_VAR} is empty`);

  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
    const hex = Buffer.from(trimmed, 'hex');
    if (hex.length >= MIN_KEY_BYTES) return hex;
  }
  const b64 = Buffer.from(trimmed, 'base64');
  if (b64.length >= MIN_KEY_BYTES) return b64;

  throw new MasterKeyError(
    `${ENV_VAR} must decode to at least ${MIN_KEY_BYTES} bytes (generate one with: openssl rand -base64 32)`,
  );
}

// Cached per process — parsing is cheap, but this also means a malformed key
// fails once at first use with a clear message rather than on every request.
let cached: { raw: string; key: Buffer } | null = null;

function masterKey(): Buffer {
  const raw = process.env[ENV_VAR];
  if (!raw) {
    throw new MasterKeyError(
      `${ENV_VAR} is not set — required for CI sync tokens and vaulted credentials. Generate one with: openssl rand -base64 32`,
    );
  }
  if (!cached || cached.raw !== raw) cached = { raw, key: parseKeyMaterial(raw) };
  return cached.key;
}

// Routes check this and return a "not configured" response, matching how every
// other optional integration in this codebase degrades.
export function masterKeyReady(): boolean {
  const raw = process.env[ENV_VAR];
  if (!raw) return false;
  try {
    parseKeyMaterial(raw);
    return true;
  } catch {
    return false;
  }
}

export type KeyPurpose =
  | 'ci-token' // CI sync request signing (ciSync.ts)
  | 'credential-wrap' // vaulted-credential key wrapping (vault.ts)
  | 'credential-fingerprint' // non-reversible "same key?" check (vault.ts)
  | 'mcp-access' // org token unlocking vaulted credentials (mcpAccess.ts)
  | 'analysis-access' // clarification email magic link (analysisAccess.ts)
  | 'audit-actor'; // caller attribution in the audit log, not reversible

// HKDF-SHA256. `purpose` is the salt (domain separation between features) and
// `context` the info (separation between objects within a feature), so no two
// call sites can accidentally derive the same bytes.
export function deriveKey(purpose: KeyPurpose, context = '', length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey(), Buffer.from(purpose, 'utf8'), Buffer.from(context, 'utf8'), length));
}

export function hmacHex(key: Buffer | string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

// Constant-time compare that tolerates length mismatch and non-hex input
// without leaking which of the two it was.
export function verifyHmacHex(key: Buffer | string, data: string, provided: string): boolean {
  const expected = Buffer.from(hmacHex(key, data), 'hex');
  let candidate: Buffer;
  try {
    candidate = Buffer.from(provided.trim().replace(/^sha256=/i, ''), 'hex');
  } catch {
    return false;
  }
  if (candidate.length !== expected.length) {
    // Still burn a comparison so a wrong-length signature is not measurably
    // faster to reject than a wrong-value one.
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(expected, candidate);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// Double-HMAC comparison: the standard way to compare two secrets of unknown,
// possibly differing length in constant time. Hashing both under a fresh random
// key per call reduces the comparison to fixed-size digests, so neither the
// length nor the content of either input is observable through timing.
export function secretsEqual(a: string, b: string): boolean {
  const nonce = randomBytes(32);
  const digestA = createHmac('sha256', nonce).update(a, 'utf8').digest();
  const digestB = createHmac('sha256', nonce).update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}
