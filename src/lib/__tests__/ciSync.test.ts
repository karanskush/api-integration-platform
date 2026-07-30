import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CI_ERROR_MESSAGE,
  CI_ERROR_STATUS,
  CI_MAX_SKEW_SECONDS,
  ciReplayKey,
  ciTokenFor,
  signCiPayload,
  verifyCiRequest,
} from '../ciSync';

const ENV = 'DOCENTAPI_MASTER_KEY';
const original = process.env[ENV];

const API_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_API_ID = '22222222-2222-2222-2222-222222222222';
const NOW = 1_780_000_000;

beforeEach(() => {
  process.env[ENV] = Buffer.alloc(32, 42).toString('base64');
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

function signedRequest(rawBody: string, opts: { apiId?: string; version?: number; timestamp?: number } = {}) {
  const apiId = opts.apiId ?? API_ID;
  const version = opts.version ?? 0;
  const timestamp = opts.timestamp ?? NOW;
  const token = ciTokenFor(apiId, version);
  return {
    apiId,
    tokenVersion: version,
    timestampHeader: String(timestamp),
    signatureHeader: signCiPayload(token, timestamp, rawBody),
    rawBody,
    nowSeconds: NOW,
  };
}

describe('ciTokenFor', () => {
  it('is deterministic, so a token can be re-read without rotating', () => {
    expect(ciTokenFor(API_ID, 0)).toBe(ciTokenFor(API_ID, 0));
  });

  it('is scoped per API', () => {
    expect(ciTokenFor(API_ID, 0)).not.toBe(ciTokenFor(OTHER_API_ID, 0));
  });

  // The entire rotation mechanism.
  it('changes when the version is bumped', () => {
    expect(ciTokenFor(API_ID, 0)).not.toBe(ciTokenFor(API_ID, 1));
  });

  it('carries a greppable prefix and url-safe body', () => {
    expect(ciTokenFor(API_ID, 0)).toMatch(/^spck_ci_[A-Za-z0-9_-]+$/);
  });

  it('changes for every API when the master key rotates', () => {
    const before = ciTokenFor(API_ID, 0);
    process.env[ENV] = Buffer.alloc(32, 43).toString('base64');
    expect(ciTokenFor(API_ID, 0)).not.toBe(before);
  });
});

describe('verifyCiRequest', () => {
  const body = JSON.stringify({ slug: 'petstore', specUrl: 'https://example.test/openapi.json' });

  it('accepts a correctly signed, fresh request', () => {
    expect(verifyCiRequest(signedRequest(body))).toEqual({ ok: true });
  });

  it('requires both headers', () => {
    const req = signedRequest(body);
    expect(verifyCiRequest({ ...req, signatureHeader: null })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verifyCiRequest({ ...req, timestampHeader: null })).toEqual({ ok: false, reason: 'missing_timestamp' });
  });

  it('rejects a non-integer timestamp', () => {
    const req = signedRequest(body);
    for (const bad of ['abc', '', '1.5', 'NaN', '-1', '0']) {
      expect(verifyCiRequest({ ...req, timestampHeader: bad }).ok).toBe(false);
    }
  });

  it('rejects a timestamp outside the freshness window in either direction', () => {
    expect(verifyCiRequest(signedRequest(body, { timestamp: NOW - CI_MAX_SKEW_SECONDS - 1 }))).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
    // Future timestamps must not buy a longer replay window than past ones.
    expect(verifyCiRequest(signedRequest(body, { timestamp: NOW + CI_MAX_SKEW_SECONDS + 1 }))).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('accepts a timestamp at the edge of the window', () => {
    expect(verifyCiRequest(signedRequest(body, { timestamp: NOW - CI_MAX_SKEW_SECONDS })).ok).toBe(true);
    expect(verifyCiRequest(signedRequest(body, { timestamp: NOW + CI_MAX_SKEW_SECONDS })).ok).toBe(true);
  });

  // The timestamp is inside the MAC, so moving it invalidates the signature.
  it('rejects a request whose timestamp was edited to look fresh', () => {
    const stale = signedRequest(body, { timestamp: NOW - 10_000 });
    const replayed = { ...stale, timestampHeader: String(NOW) };
    expect(verifyCiRequest(replayed)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered body', () => {
    const req = signedRequest(body);
    expect(verifyCiRequest({ ...req, rawBody: body.replace('petstore', 'other-api') })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a signature minted for a different API', () => {
    const req = signedRequest(body, { apiId: OTHER_API_ID });
    expect(verifyCiRequest({ ...req, apiId: API_ID })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token from a superseded version', () => {
    const req = signedRequest(body, { version: 0 });
    expect(verifyCiRequest({ ...req, tokenVersion: 1 })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a garbage signature without throwing', () => {
    const req = signedRequest(body);
    for (const bad of ['sha256=zzz', 'nonsense', '', 'sha256=']) {
      expect(verifyCiRequest({ ...req, signatureHeader: bad }).ok).toBe(false);
    }
  });

  it('is byte-exact about the body, not JSON-equivalent', () => {
    const req = signedRequest('{"slug":"petstore"}');
    // Same JSON value, different bytes — must not verify.
    expect(verifyCiRequest({ ...req, rawBody: '{"slug": "petstore"}' }).ok).toBe(false);
  });
});

describe('error surface', () => {
  it('maps every rejection reason to a status and message', () => {
    const reasons = ['missing_signature', 'missing_timestamp', 'bad_timestamp', 'stale_timestamp', 'bad_signature'] as const;
    for (const reason of reasons) {
      expect(CI_ERROR_STATUS[reason]).toBeGreaterThanOrEqual(400);
      expect(CI_ERROR_MESSAGE[reason].length).toBeGreaterThan(0);
    }
  });

  it('never reveals the expected signature or token in an error message', () => {
    const token = ciTokenFor(API_ID, 0);
    for (const message of Object.values(CI_ERROR_MESSAGE)) {
      expect(message).not.toContain(token);
      expect(message).not.toContain(API_ID);
    }
  });
});

describe('ciReplayKey', () => {
  it('is unique per API and signature', () => {
    expect(ciReplayKey(API_ID, 'sha256=abc')).not.toBe(ciReplayKey(OTHER_API_ID, 'sha256=abc'));
    expect(ciReplayKey(API_ID, 'sha256=abc')).not.toBe(ciReplayKey(API_ID, 'sha256=def'));
  });

  it('strips the prefix and bounds the key length', () => {
    const key = ciReplayKey(API_ID, `sha256=${'a'.repeat(200)}`);
    expect(key).not.toContain('sha256=');
    expect(key.length).toBeLessThan(160);
  });
});
