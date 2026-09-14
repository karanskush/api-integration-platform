import { describe, expect, it } from 'vitest';
import { describeInference, inferEnvironment, looksLive } from '../credentialInference';

// Fixtures deliberately do not match any vendor's real key format beyond the
// prefix under test, so a scanner never mistakes one for a credential.
describe('inferEnvironment', () => {
  it('recognises a test prefix', () => {
    expect(inferEnvironment('sk_test_fixture0000')).toEqual({ environment: 'sandbox', basis: 'known_prefix' });
    expect(inferEnvironment('PK_TEST_fixture')).toEqual({ environment: 'sandbox', basis: 'known_prefix' });
  });

  it('recognises a live prefix', () => {
    expect(inferEnvironment('sk_live_fixture0000')).toEqual({ environment: 'production', basis: 'known_prefix' });
    expect(looksLive('sk_live_fixture0000')).toBe(true);
    expect(looksLive('sk_test_fixture0000')).toBe(false);
  });

  it('prefers a prefix the owner declared', () => {
    expect(inferEnvironment('dub_sbx_fixture', { declaredTestPrefix: 'dub_sbx_' })).toEqual({ environment: 'sandbox', basis: 'declared_prefix' });
  });

  it('reads a sandbox-looking host when the key says nothing', () => {
    expect(inferEnvironment('opaque-fixture', { baseUrls: ['https://api.sandbox.example.com/v1'] })).toEqual({ environment: 'sandbox', basis: 'host' });
    expect(inferEnvironment('opaque-fixture', { baseUrls: ['https://api-sandbox.example.com'] })).toEqual({ environment: 'sandbox', basis: 'host' });
    expect(inferEnvironment('opaque-fixture', { declaredSandboxBaseUrl: 'https://sb.example.com' })).toEqual({ environment: 'sandbox', basis: 'host' });
  });

  it('admits it does not know', () => {
    expect(inferEnvironment('dub_fixture0000', { baseUrls: ['https://api.dub.co'] })).toEqual({ environment: 'unknown', basis: 'none' });
  });

  it('never echoes the key', () => {
    const secret = 'sk_test_SENTINEL_value';
    const out = inferEnvironment(secret);
    expect(JSON.stringify(out)).not.toContain('SENTINEL');
    expect(describeInference(out)).not.toContain('SENTINEL');
  });

  it('describes each outcome for the owner', () => {
    expect(describeInference({ environment: 'production', basis: 'known_prefix' })).toContain('LIVE');
    expect(describeInference({ environment: 'unknown', basis: 'none' })).toContain('trust your selection');
  });
});
