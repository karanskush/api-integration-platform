import { describe, expect, it } from 'vitest';
import { parseConsentPatch, parseCredentialPost } from '../credentialRequest';

describe('parseCredentialPost', () => {
  it('accepts a sandbox key with the confirmation and records what it looked like', () => {
    const out = parseCredentialPost({ secret: 'sk_test_fixture', environment: 'sandbox', confirmedNoRealData: true, writeConsent: true, label: ' Dub test  ' });
    expect(out).toMatchObject({
      ok: true,
      value: { environment: 'sandbox', writeConsent: true, burstConsent: false, label: 'Dub test', inferred: { environment: 'sandbox', basis: 'known_prefix' }, warning: null },
    });
  });

  it('requires the no-real-data confirmation for a sandbox key', () => {
    const out = parseCredentialPost({ secret: 'opaque-fixture', environment: 'sandbox' });
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(out.ok === false && out.error).toMatch(/no real customers/);
  });

  it('never stores a live-looking key as sandbox, whatever the owner says', () => {
    const out = parseCredentialPost({ secret: 'sk_live_fixture', environment: 'sandbox', confirmedNoRealData: true });
    expect(out.ok === false && out.error).toMatch(/live key/);
  });

  it('refuses write or burst consent on a production credential', () => {
    expect(parseCredentialPost({ secret: 'opaque', environment: 'production', writeConsent: true }).ok).toBe(false);
    expect(parseCredentialPost({ secret: 'opaque', environment: 'production', burstConsent: true }).ok).toBe(false);
  });

  it('warns when a test-looking key is stored as production', () => {
    const out = parseCredentialPost({ secret: 'sk_test_fixture', environment: 'production' });
    expect(out.ok && out.value.warning).toMatch(/looks like a test key/);
  });

  it('defaults the environment to production for API compatibility', () => {
    const out = parseCredentialPost({ secret: 'opaque' });
    expect(out.ok && out.value.environment).toBe('production');
  });

  it('rejects an empty or oversized secret and an unknown environment', () => {
    expect(parseCredentialPost({ secret: '' }).ok).toBe(false);
    expect(parseCredentialPost({ secret: 'x'.repeat(9000) }).ok).toBe(false);
    expect(parseCredentialPost({ secret: 'x', environment: 'staging' }).ok).toBe(false);
    expect(parseCredentialPost(null).ok).toBe(false);
  });

  it('strips control characters from the label and bounds its length', () => {
    const bell = String.fromCharCode(7);
    const out = parseCredentialPost({ secret: 'x', label: `a${bell}b` + 'z'.repeat(100) });
    expect(out.ok && out.value.label).toHaveLength(60);
    expect(out.ok && out.value.label?.startsWith('ab')).toBe(true);
  });

  it('never returns the secret anywhere but the secret field', () => {
    const out = parseCredentialPost({ secret: 'sk_test_SENTINEL_1234', environment: 'sandbox', confirmedNoRealData: true });
    const { secret: _s, ...rest } = out.ok ? out.value : { secret: '' };
    expect(JSON.stringify(rest)).not.toContain('SENTINEL');
  });
});

describe('parseConsentPatch', () => {
  it('accepts any subset of label, writeConsent and burstConsent', () => {
    expect(parseConsentPatch({ writeConsent: true })).toEqual({ ok: true, value: { writeConsent: true } });
    expect(parseConsentPatch({ label: 'x', burstConsent: false })).toEqual({ ok: true, value: { label: 'x', burstConsent: false } });
  });

  it('rejects a non-boolean consent and an empty patch', () => {
    expect(parseConsentPatch({ writeConsent: 'yes' }).ok).toBe(false);
    expect(parseConsentPatch({}).ok).toBe(false);
  });
});
