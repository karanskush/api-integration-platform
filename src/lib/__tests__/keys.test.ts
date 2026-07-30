import { afterEach, describe, expect, it } from 'vitest';
import { deriveKey, hmacHex, MasterKeyError, masterKeyReady, randomToken, verifyHmacHex } from '../keys';

const ENV = 'DOCENTAPI_MASTER_KEY';
const original = process.env[ENV];

// 32 bytes, expressed both ways.
const B64_KEY = Buffer.alloc(32, 7).toString('base64');
const HEX_KEY = Buffer.alloc(32, 9).toString('hex');

function setKey(value: string | undefined) {
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
}

afterEach(() => setKey(original));

describe('masterKeyReady', () => {
  it('is false when unset', () => {
    setKey(undefined);
    expect(masterKeyReady()).toBe(false);
  });

  it('is false for an empty or whitespace value', () => {
    setKey('');
    expect(masterKeyReady()).toBe(false);
    setKey('   ');
    expect(masterKeyReady()).toBe(false);
  });

  it('is false for key material shorter than 256 bits', () => {
    setKey(Buffer.alloc(16, 1).toString('base64'));
    expect(masterKeyReady()).toBe(false);
  });

  it('accepts base64 and hex material of sufficient length', () => {
    setKey(B64_KEY);
    expect(masterKeyReady()).toBe(true);
    setKey(HEX_KEY);
    expect(masterKeyReady()).toBe(true);
  });
});

describe('deriveKey', () => {
  it('throws a clear error when no master key is configured', () => {
    setKey(undefined);
    expect(() => deriveKey('ci-token')).toThrow(MasterKeyError);
    expect(() => deriveKey('ci-token')).toThrow(/openssl rand/);
  });

  it('is deterministic for the same purpose and context', () => {
    setKey(B64_KEY);
    expect(deriveKey('ci-token', 'api-1').toString('hex')).toBe(deriveKey('ci-token', 'api-1').toString('hex'));
  });

  // Domain separation: the whole reason for HKDF rather than using the master
  // key directly.
  it('derives different keys for different purposes', () => {
    setKey(B64_KEY);
    expect(deriveKey('ci-token', 'x').toString('hex')).not.toBe(deriveKey('credential-wrap', 'x').toString('hex'));
  });

  it('derives different keys for different contexts', () => {
    setKey(B64_KEY);
    expect(deriveKey('ci-token', 'api-1').toString('hex')).not.toBe(deriveKey('ci-token', 'api-2').toString('hex'));
  });

  it('changes every subkey when the master key changes', () => {
    setKey(B64_KEY);
    const before = deriveKey('ci-token', 'api-1').toString('hex');
    setKey(HEX_KEY);
    expect(deriveKey('ci-token', 'api-1').toString('hex')).not.toBe(before);
  });

  it('produces the requested length, defaulting to 32 bytes', () => {
    setKey(B64_KEY);
    expect(deriveKey('ci-token').length).toBe(32);
    expect(deriveKey('ci-token', '', 64).length).toBe(64);
  });

  it('never returns the master key itself', () => {
    setKey(B64_KEY);
    expect(deriveKey('ci-token').toString('base64')).not.toBe(B64_KEY);
  });
});

describe('hmacHex / verifyHmacHex', () => {
  it('verifies a signature it produced', () => {
    const sig = hmacHex('secret', 'payload');
    expect(verifyHmacHex('secret', 'payload', sig)).toBe(true);
  });

  it('accepts the sha256= prefix GitHub-style senders use', () => {
    const sig = hmacHex('secret', 'payload');
    expect(verifyHmacHex('secret', 'payload', `sha256=${sig}`)).toBe(true);
    expect(verifyHmacHex('secret', 'payload', `SHA256=${sig}`)).toBe(true);
  });

  it('tolerates surrounding whitespace from a header', () => {
    const sig = hmacHex('secret', 'payload');
    expect(verifyHmacHex('secret', 'payload', `  ${sig}  `)).toBe(true);
  });

  it('rejects a wrong key, wrong payload, or tampered signature', () => {
    const sig = hmacHex('secret', 'payload');
    expect(verifyHmacHex('other-secret', 'payload', sig)).toBe(false);
    expect(verifyHmacHex('secret', 'payload-tampered', sig)).toBe(false);
    expect(verifyHmacHex('secret', 'payload', sig.replace(/.$/, '0').replace(/^(.)/, (m) => (m === '0' ? '1' : '0'))).valueOf()).toBe(false);
  });

  it('rejects malformed, empty, and wrong-length signatures without throwing', () => {
    for (const bad of ['', 'not-hex', 'zz'.repeat(32), 'abcd', 'sha256=', '0'.repeat(63)]) {
      expect(verifyHmacHex('secret', 'payload', bad)).toBe(false);
    }
  });

  it('is sensitive to the payload delimiter, so timestamp and body cannot be reshuffled', () => {
    // "1.23" and "12.3" must not share a signature.
    expect(hmacHex('k', '1.23')).not.toBe(hmacHex('k', '12.3'));
  });
});

describe('randomToken', () => {
  it('returns url-safe tokens of the requested entropy', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url').length).toBe(32);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomToken(16)));
    expect(seen.size).toBe(50);
  });
});
