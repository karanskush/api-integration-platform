import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialFingerprint,
  credentialHint,
  fingerprintsMatch,
  kekId,
  openCredential,
  rotateCredential,
  sealCredential,
  VaultError,
  type CredentialContext,
} from '../vault';

const ENV = 'DOCENTAPI_MASTER_KEY';
const original = process.env[ENV];

// Deliberately NOT shaped like any real vendor's key format: a fixture that
// pattern-matches a live credential trips secret scanners on every push.
const SECRET = 'fixture-upstream-credential-0123456789';

const ctx: CredentialContext = {
  orgId: 'org-1111',
  apiId: 'api-2222',
  environment: 'production',
  keyVersion: 1,
};

beforeEach(() => {
  process.env[ENV] = Buffer.alloc(32, 5).toString('base64');
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe('sealCredential / openCredential', () => {
  it('round-trips a secret', () => {
    const sealed = sealCredential(SECRET, ctx);
    expect(openCredential(sealed, ctx)).toBe(SECRET);
  });

  it('never stores the plaintext in any field of the envelope', () => {
    const sealed = sealCredential(SECRET, ctx);
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('fixture-upstream');
    // Nor is it recoverable from a base64 decode of any field.
    for (const value of [sealed.ciphertext, sealed.iv, sealed.authTag, sealed.wrappedDek]) {
      expect(Buffer.from(value, 'base64').toString('utf8')).not.toContain('fixture-upstream');
    }
  });

  it('produces a different ciphertext every time, even for the same input', () => {
    const a = sealCredential(SECRET, ctx);
    const b = sealCredential(SECRET, ctx);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    // Both still open to the same plaintext.
    expect(openCredential(a, ctx)).toBe(openCredential(b, ctx));
  });

  it('rejects an empty secret and an oversized one', () => {
    expect(() => sealCredential('', ctx)).toThrow(VaultError);
    expect(() => sealCredential('x'.repeat(9000), ctx)).toThrow(/exceeds/);
  });

  it('round-trips unicode and whitespace-bearing secrets byte-exactly', () => {
    for (const secret of ['ключ-🔐-key', 'has spaces and\ttabs', '{"json":"credential"}']) {
      expect(openCredential(sealCredential(secret, ctx), ctx)).toBe(secret);
    }
  });
});

describe('AAD context binding', () => {
  // The property that stops a database-level attacker from moving a row between
  // tenants and having it decrypt under the destination's key path.
  it('refuses to decrypt a credential moved to another org', () => {
    const sealed = sealCredential(SECRET, ctx);
    expect(() => openCredential(sealed, { ...ctx, orgId: 'org-9999' })).toThrow(VaultError);
  });

  it('refuses to decrypt a credential moved to another API', () => {
    const sealed = sealCredential(SECRET, ctx);
    expect(() => openCredential(sealed, { ...ctx, apiId: 'api-9999' })).toThrow(VaultError);
  });

  it('refuses to decrypt a credential moved to another environment', () => {
    const sealed = sealCredential(SECRET, ctx);
    expect(() => openCredential(sealed, { ...ctx, environment: 'sandbox' })).toThrow(VaultError);
  });

  it('refuses a key-version mismatch', () => {
    const sealed = sealCredential(SECRET, ctx);
    expect(() => openCredential(sealed, { ...ctx, keyVersion: 2 })).toThrow(/key version/i);
  });
});

describe('tamper detection', () => {
  it('rejects a flipped byte in the ciphertext', () => {
    const sealed = sealCredential(SECRET, ctx);
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    expect(() => openCredential({ ...sealed, ciphertext: bytes.toString('base64') }, ctx)).toThrow(VaultError);
  });

  it('rejects a flipped byte in the auth tag', () => {
    const sealed = sealCredential(SECRET, ctx);
    const tag = Buffer.from(sealed.authTag, 'base64');
    tag[0] ^= 0xff;
    expect(() => openCredential({ ...sealed, authTag: tag.toString('base64') }, ctx)).toThrow(VaultError);
  });

  it('rejects a swapped IV', () => {
    const a = sealCredential(SECRET, ctx);
    const b = sealCredential(SECRET, ctx);
    expect(() => openCredential({ ...a, iv: b.iv }, ctx)).toThrow(VaultError);
  });

  it('rejects a wrapped DEK from a different credential', () => {
    const a = sealCredential(SECRET, ctx);
    const b = sealCredential('another-secret-value', ctx);
    expect(() => openCredential({ ...a, wrappedDek: b.wrappedDek }, ctx)).toThrow(VaultError);
  });

  it('rejects a malformed wrapped DEK without leaking which part was wrong', () => {
    const sealed = sealCredential(SECRET, ctx);
    for (const bad of ['', 'a.b', 'a.b.c.d', 'not-base64-at-all']) {
      expect(() => openCredential({ ...sealed, wrappedDek: bad }, ctx)).toThrow(/malformed|could not be decrypted/);
    }
  });

  it('rejects an unknown scheme', () => {
    const sealed = sealCredential(SECRET, ctx);
    expect(() => openCredential({ ...sealed, scheme: 'rot13' as never }, ctx)).toThrow(/scheme/);
  });

  it('never includes key material or plaintext in an error message', () => {
    const sealed = sealCredential(SECRET, ctx);
    try {
      openCredential(sealed, { ...ctx, orgId: 'other' });
      throw new Error('expected a throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(sealed.wrappedDek);
      expect(message).not.toContain(sealed.ciphertext);
    }
  });
});

describe('master key dependence', () => {
  it('cannot decrypt after the master key changes', () => {
    const sealed = sealCredential(SECRET, ctx);
    process.env[ENV] = Buffer.alloc(32, 6).toString('base64');
    expect(() => openCredential(sealed, ctx)).toThrow(VaultError);
  });

  it('fails clearly when the master key is absent', () => {
    delete process.env[ENV];
    expect(() => sealCredential(SECRET, ctx)).toThrow(/DOCENTAPI_MASTER_KEY/);
  });
});

describe('rotateCredential', () => {
  it('re-seals under the next key version, preserving the secret', () => {
    const sealed = sealCredential(SECRET, ctx);
    const rotated = rotateCredential(sealed, ctx);

    expect(rotated.keyVersion).toBe(ctx.keyVersion + 1);
    expect(openCredential(rotated, { ...ctx, keyVersion: rotated.keyVersion })).toBe(SECRET);
  });

  it('produces an envelope the old version can no longer open', () => {
    const sealed = sealCredential(SECRET, ctx);
    const rotated = rotateCredential(sealed, ctx);
    expect(() => openCredential(rotated, ctx)).toThrow(VaultError);
  });
});

describe('kekId', () => {
  it('records the scheme, org, and version so rows can be migrated selectively', () => {
    expect(kekId(ctx)).toBe('aesgcm-hkdf-v1:org=org-1111:v=1');
    expect(kekId({ ...ctx, keyVersion: 2 })).not.toBe(kekId(ctx));
  });
});

describe('credentialFingerprint', () => {
  it('is stable for the same secret in the same org', () => {
    expect(credentialFingerprint(SECRET, ctx)).toBe(credentialFingerprint(SECRET, ctx));
  });

  it('differs for a different secret', () => {
    expect(credentialFingerprint(SECRET, ctx)).not.toBe(credentialFingerprint('other', ctx));
  });

  it('differs across orgs, so a shared key is not correlatable between tenants', () => {
    expect(credentialFingerprint(SECRET, ctx)).not.toBe(credentialFingerprint(SECRET, { ...ctx, orgId: 'org-x' }));
  });

  it('does not reveal the secret', () => {
    const fingerprint = credentialFingerprint(SECRET, ctx);
    expect(fingerprint).not.toContain('fixture-upstream');
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('compares in constant time and matches only identical fingerprints', () => {
    const a = credentialFingerprint(SECRET, ctx);
    expect(fingerprintsMatch(a, a)).toBe(true);
    expect(fingerprintsMatch(a, credentialFingerprint('other', ctx))).toBe(false);
    expect(fingerprintsMatch(a, '')).toBe(false);
  });
});

describe('credentialHint', () => {
  it('shows only the last four characters of a long secret', () => {
    expect(credentialHint('long-enough-credential-ijkl')).toBe('••••ijkl');
  });

  it('reveals nothing at all for a short secret', () => {
    expect(credentialHint('short')).toBe('••••');
    expect(credentialHint('12345678901')).toBe('••••');
  });
});
