// Exercises the in-memory fallback path (no UPSTASH_* env in tests), which is
// what getLimiter returns when hasRedis() is false.

import { describe, expect, it } from 'vitest';
import { getLimiter, tooMany } from '../ratelimit';

describe('getLimiter', () => {
  it('enforces the configured limit within a window', async () => {
    const limiter = getLimiter('test-basic', { limit: 2, windowSec: 60 });
    expect((await limiter.limit('key-a')).success).toBe(true);
    expect((await limiter.limit('key-a')).success).toBe(true);
    expect((await limiter.limit('key-a')).success).toBe(false);
  });

  it('counts each key independently', async () => {
    const limiter = getLimiter('test-per-key', { limit: 1, windowSec: 60 });
    expect((await limiter.limit('key-a')).success).toBe(true);
    expect((await limiter.limit('key-a')).success).toBe(false);
    expect((await limiter.limit('key-b')).success).toBe(true);
  });

  it('returns the same instance for an identical scope and config', () => {
    const a = getLimiter('test-identity', { limit: 5, windowSec: 60 });
    const b = getLimiter('test-identity', { limit: 5, windowSec: 60 });
    expect(a).toBe(b);
  });

  // The bug this guards: caching on scope alone pins the first config ever
  // seen, so a plan upgrade would keep serving the old ceiling.
  it('returns a distinct limiter when the config changes for the same scope', async () => {
    const tight = getLimiter('test-config-change', { limit: 1, windowSec: 60 });
    const loose = getLimiter('test-config-change', { limit: 50, windowSec: 60 });
    expect(loose).not.toBe(tight);

    expect((await tight.limit('org-1')).success).toBe(true);
    expect((await tight.limit('org-1')).success).toBe(false);
    // Same tenant, upgraded ceiling — must not inherit the exhausted window.
    expect((await loose.limit('org-1')).success).toBe(true);
  });

  it('distinguishes configs that differ only by window', () => {
    const hourly = getLimiter('test-window', { limit: 10, windowSec: 3600 });
    const daily = getLimiter('test-window', { limit: 10, windowSec: 86_400 });
    expect(hourly).not.toBe(daily);
  });

  it('reports a reset timestamp in the future', async () => {
    const limiter = getLimiter('test-reset', { limit: 1, windowSec: 60 });
    const { reset } = await limiter.limit('key-a');
    expect(reset).toBeGreaterThan(Date.now());
  });
});

describe('tooMany', () => {
  it('returns 429 with a Retry-After of at least one second', async () => {
    const res = tooMany(Date.now() + 5_000);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    await expect(res.json()).resolves.toEqual({ error: 'Rate limit exceeded' });
  });

  it('never emits a zero or negative Retry-After for an elapsed reset', () => {
    const res = tooMany(Date.now() - 10_000);
    expect(Number(res.headers.get('Retry-After'))).toBe(1);
  });
});
