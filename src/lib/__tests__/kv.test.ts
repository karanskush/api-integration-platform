// Regression coverage for a real production bug: @upstash/redis's get()
// auto-attempts JSON.parse() on whatever it reads back, with no opt-out. A
// raw spec is itself JSON text in the (overwhelmingly common) JSON-format
// case, so storing it verbatim meant getRawSpec() silently returned a PARSED
// OBJECT instead of the original string — persist.ts's
// createHash(...).update(rawText) then threw "data argument must be of type
// string", crashing every claim of a JSON-format import. This mock
// replicates that exact auto-parse-on-read behavior so the regression is
// actually caught, not just asserted away.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV = 'UPSTASH_REDIS_REST_URL';
const TOKEN_ENV = 'UPSTASH_REDIS_REST_TOKEN';
const originalUrl = process.env[ENV];
const originalToken = process.env[TOKEN_ENV];

let store: Map<string, string>;

function mockRedisClient() {
  return {
    get: vi.fn(async (key: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      // The real SDK's behavior: try to parse, fall back to the raw string.
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, String(value));
    }),
    sadd: vi.fn(async () => 1),
    lpush: vi.fn(async () => 1),
  };
}

beforeEach(() => {
  store = new Map();
  process.env[ENV] = 'https://example.upstash.io';
  process.env[TOKEN_ENV] = 'token';
});

afterEach(() => {
  vi.resetModules();
  if (originalUrl === undefined) delete process.env[ENV];
  else process.env[ENV] = originalUrl;
  if (originalToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = originalToken;
});

async function loadKv() {
  vi.resetModules();
  vi.doMock('@upstash/redis', () => ({
    Redis: { fromEnv: () => mockRedisClient() },
  }));
  return import('../kv');
}

describe('getRawSpec / setRawSpec round-trip', () => {
  it('returns the exact original string for JSON-format spec text, not a parsed object', async () => {
    const { kv } = await loadKv();
    const jsonSpec = '{"openapi":"3.0.0","info":{"title":"Example"}}';

    await kv().setRawSpec('abc123', jsonSpec, 3600);
    const result = await kv().getRawSpec('abc123');

    expect(typeof result).toBe('string');
    expect(result).toBe(jsonSpec);
  });

  it('round-trips non-JSON (YAML) spec text unchanged', async () => {
    const { kv } = await loadKv();
    const yamlSpec = 'openapi: 3.1.0\ninfo:\n  title: Example API\n';

    await kv().setRawSpec('def456', yamlSpec, 3600);
    const result = await kv().getRawSpec('def456');

    expect(result).toBe(yamlSpec);
  });

  it('round-trips text containing unicode and special characters', async () => {
    const { kv } = await loadKv();
    const tricky = '{"description":"emoji ✅ and \\"quotes\\" and \\nnewlines"}';

    await kv().setRawSpec('ghi789', tricky, 3600);
    expect(await kv().getRawSpec('ghi789')).toBe(tricky);
  });

  it('returns null for a missing key', async () => {
    const { kv } = await loadKv();
    expect(await kv().getRawSpec('nonexistent')).toBeNull();
  });

  // The exact real-world trigger: what persist.ts actually does with the
  // result — hash it. A regression here throws, not just mismatches.
  it('the round-tripped value is hashable (the actual production crash)', async () => {
    const { kv } = await loadKv();
    const jsonSpec = '{"openapi":"3.0.0"}';
    await kv().setRawSpec('jkl012', jsonSpec, 3600);
    const result = await kv().getRawSpec('jkl012');

    const { createHash } = await import('node:crypto');
    expect(() => createHash('sha256').update(result!).digest('hex')).not.toThrow();
  });
});

describe('getImport / setImport round-trip (unaffected — deliberately relies on auto-parse)', () => {
  it('still returns a real object, not a string', async () => {
    const { kv } = await loadKv();
    const record = {
      id: 'rec1',
      name: 'Test API',
      source: 'openapi' as const,
      baseUrls: [],
      auth: 'none' as const,
      actions: [],
      counts: { total: 0, read: 0, write: 0, destructive: 0 },
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };

    await kv().setImport(record, 3600);
    const result = await kv().getImport('rec1');

    expect(result).toEqual(record);
  });
});
