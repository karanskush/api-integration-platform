// CI sync request authentication (TECH_IMPLEMENTATION.md §3.10).
//
// The GitHub Action posts a signed payload whenever the spec changes. Two
// design choices matter here:
//
// 1. THE TOKEN IS NEVER STORED. It is derived deterministically from the master
//    key, the api id, and a per-api version counter. Verification re-derives it
//    rather than looking it up, so there is no shared-secret column to leak in
//    a database dump, and no plaintext-secret-at-rest problem to solve. The
//    tradeoff is that the token can be re-derived by the server at will, which
//    is exactly what makes "show it once, never again" honest: re-issuing
//    without rotating returns the same token.
//
// 2. THE SIGNATURE COVERS A TIMESTAMP. Signing the body alone makes any
//    captured request replayable forever. Signing `${timestamp}.${body}` plus
//    a freshness window bounds replay to the window, and the caller-supplied
//    timestamp can't be tampered with because it is inside the MAC.

import { deriveKey, hmacHex, verifyHmacHex } from './keys';

export const CI_SIGNATURE_HEADER = 'x-docentapi-signature';
export const CI_TIMESTAMP_HEADER = 'x-docentapi-timestamp';

// Generous enough for a slow CI runner, tight enough that a leaked request
// body stops being useful in minutes rather than never.
export const CI_MAX_SKEW_SECONDS = 300;

// Deterministic per (api, version). Rotating = bump apis.ci_token_version,
// which invalidates every previously issued token for that API and nothing
// else.
export function ciTokenFor(apiId: string, version: number): string {
  const key = deriveKey('ci-token', `${apiId}:${version}`);
  // Prefixed so a leaked token is greppable in logs and recognisable in a
  // secret scanner, and so the format can evolve without ambiguity.
  return `spck_ci_${key.toString('base64url')}`;
}

export function signCiPayload(token: string, timestamp: number, rawBody: string): string {
  return `sha256=${hmacHex(token, `${timestamp}.${rawBody}`)}`;
}

export type CiVerifyInput = {
  apiId: string;
  tokenVersion: number;
  timestampHeader: string | null;
  signatureHeader: string | null;
  rawBody: string;
  nowSeconds?: number;
};

export type CiVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'missing_timestamp' | 'bad_timestamp' | 'stale_timestamp' | 'bad_signature' };

export function verifyCiRequest(input: CiVerifyInput): CiVerifyResult {
  const { apiId, tokenVersion, timestampHeader, signatureHeader, rawBody } = input;
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' };
  if (!timestampHeader) return { ok: false, reason: 'missing_timestamp' };

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || !Number.isInteger(timestamp) || timestamp <= 0) {
    return { ok: false, reason: 'bad_timestamp' };
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Symmetric window: a clock-ahead runner is as legitimate as a clock-behind
  // one, and a far-future timestamp must not buy an attacker a longer replay
  // window than a past one.
  if (Math.abs(now - timestamp) > CI_MAX_SKEW_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  const token = ciTokenFor(apiId, tokenVersion);
  const expected = `${timestamp}.${rawBody}`;
  return verifyHmacHex(token, expected, signatureHeader) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

// Replay key for the storage-backed nonce guard: the signature itself is
// unique per (token, timestamp, body), so it needs no extra nonce field.
export function ciReplayKey(apiId: string, signatureHeader: string): string {
  return `docentapi:ci:seen:${apiId}:${signatureHeader.replace(/^sha256=/i, '').slice(0, 64)}`;
}

export const CI_ERROR_STATUS: Record<Exclude<CiVerifyResult, { ok: true }>['reason'], number> = {
  missing_signature: 401,
  missing_timestamp: 401,
  bad_timestamp: 400,
  stale_timestamp: 401,
  bad_signature: 401,
};

export const CI_ERROR_MESSAGE: Record<Exclude<CiVerifyResult, { ok: true }>['reason'], string> = {
  missing_signature: `Missing ${CI_SIGNATURE_HEADER} header`,
  missing_timestamp: `Missing ${CI_TIMESTAMP_HEADER} header`,
  bad_timestamp: `${CI_TIMESTAMP_HEADER} must be integer Unix seconds`,
  stale_timestamp: `Request timestamp is outside the ${CI_MAX_SKEW_SECONDS}s freshness window — check the runner's clock`,
  // Deliberately identical wording to a missing/stale signature failure: an
  // unauthenticated caller learns nothing about which part was wrong.
  bad_signature: 'Signature verification failed',
};
