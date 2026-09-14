// The rate-limit policy parser. Only the POLICY is durable knowledge — how
// many, per what window — so `remaining` and `reset` never come out of here.

import { describe, expect, it } from 'vitest';
import { parseRateLimitPolicies } from '../rateLimit';

describe('IETF structured RateLimit-Policy', () => {
  it('reads a named policy with quota and window', () => {
    expect(parseRateLimitPolicies({ 'RateLimit-Policy': '"default";q=100;w=60' })).toEqual([
      { name: 'default', limit: 100, windowSeconds: 60, header: 'ratelimit-policy', raw: '"default";q=100;w=60' },
    ]);
  });

  it('reads several policies in one header', () => {
    const policies = parseRateLimitPolicies({ 'ratelimit-policy': '"burst";q=10;w=1, "daily";q=1000;w=86400' });
    expect(policies.map((p) => [p.name, p.limit, p.windowSeconds])).toEqual([
      ['burst', 10, 1],
      ['daily', 1000, 86400],
    ]);
  });

  it('reads the older draft form on RateLimit-Limit', () => {
    expect(parseRateLimitPolicies({ 'RateLimit-Limit': '100, 100;w=60' })).toEqual([
      { limit: 100, windowSeconds: null, header: 'ratelimit-limit', raw: '100, 100;w=60' },
      { limit: 100, windowSeconds: 60, header: 'ratelimit-limit', raw: '100, 100;w=60' },
    ]);
  });

  it('ignores the combined RateLimit header, which carries position not policy', () => {
    expect(parseRateLimitPolicies({ RateLimit: '"default";r=50;t=30' })).toEqual([]);
  });
});

describe('legacy X-RateLimit family', () => {
  it('reports the quota and admits the window is unknown', () => {
    expect(
      parseRateLimitPolicies({ 'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': '4999', 'X-RateLimit-Reset': '1725800000' }),
    ).toEqual([{ limit: 5000, windowSeconds: null, header: 'x-ratelimit-limit', raw: '5000' }]);
  });

  it('prefers the IETF header when both families are present', () => {
    const policies = parseRateLimitPolicies({ 'X-RateLimit-Limit': '5000', 'RateLimit-Policy': '"h";q=5000;w=3600' });
    expect(policies).toHaveLength(1);
    expect(policies[0].windowSeconds).toBe(3600);
  });
});

describe('what it refuses', () => {
  it('yields nothing for absent headers', () => {
    expect(parseRateLimitPolicies(undefined)).toEqual([]);
    expect(parseRateLimitPolicies({})).toEqual([]);
  });

  it('never guesses from garbage', () => {
    expect(parseRateLimitPolicies({ 'X-RateLimit-Limit': 'unlimited' })).toEqual([]);
    expect(parseRateLimitPolicies({ 'RateLimit-Policy': '"x";q=abc;w=60' })).toEqual([]);
    expect(parseRateLimitPolicies({ 'X-RateLimit-Limit': '-5' })).toEqual([]);
    expect(parseRateLimitPolicies({ 'X-RateLimit-Limit': '0' })).toEqual([]);
  });

  it('bounds the policy count and the raw value', () => {
    const many = Array.from({ length: 10 }, (_, i) => `"p${i}";q=${i + 1};w=1`).join(', ');
    const policies = parseRateLimitPolicies({ 'RateLimit-Policy': many });
    expect(policies.length).toBeLessThanOrEqual(4);
    expect(policies[0].raw.length).toBeLessThanOrEqual(120);
  });

  it('never carries remaining or reset', () => {
    const s = JSON.stringify(parseRateLimitPolicies({ 'RateLimit-Policy': '"d";q=10;w=1', RateLimit: '"d";r=3;t=1' }));
    expect(s).not.toContain('"r"');
    expect(s).not.toContain('remaining');
  });
});
