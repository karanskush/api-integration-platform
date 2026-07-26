import { afterEach, describe, expect, it } from 'vitest';
import { cronReady, verifyCronRequest } from '../cronAuth';

const original = process.env.CRON_SECRET;

function request(authorization?: string): Request {
  return new Request('https://example.test/api/cron/reverify', {
    method: 'POST',
    ...(authorization ? { headers: { authorization } } : {}),
  });
}

afterEach(() => {
  if (original === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = original;
});

describe('cronReady', () => {
  it('reflects whether a secret is configured', () => {
    delete process.env.CRON_SECRET;
    expect(cronReady()).toBe(false);
    process.env.CRON_SECRET = 's3cret';
    expect(cronReady()).toBe(true);
  });
});

describe('verifyCronRequest', () => {
  // The important one: an unconfigured deployment must not be an open one.
  it('fails closed with 503 when no secret is configured', () => {
    delete process.env.CRON_SECRET;
    expect(verifyCronRequest(request('Bearer anything'))).toMatchObject({ ok: false, status: 503 });
    expect(verifyCronRequest(request())).toMatchObject({ ok: false, status: 503 });
  });

  it('accepts the configured bearer secret', () => {
    process.env.CRON_SECRET = 'correct-horse-battery-staple';
    expect(verifyCronRequest(request('Bearer correct-horse-battery-staple'))).toEqual({ ok: true });
  });

  it('rejects a missing, empty, or wrong secret with 401', () => {
    process.env.CRON_SECRET = 'correct-horse-battery-staple';
    expect(verifyCronRequest(request())).toMatchObject({ ok: false, status: 401 });
    expect(verifyCronRequest(request('Bearer '))).toMatchObject({ ok: false, status: 401 });
    expect(verifyCronRequest(request('Bearer wrong'))).toMatchObject({ ok: false, status: 401 });
  });

  it('requires the Bearer scheme', () => {
    process.env.CRON_SECRET = 'abc';
    expect(verifyCronRequest(request('abc'))).toMatchObject({ ok: false, status: 401 });
    expect(verifyCronRequest(request('Basic abc'))).toMatchObject({ ok: false, status: 401 });
    // Case matters: Vercel sends exactly "Bearer".
    expect(verifyCronRequest(request('bearer abc'))).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a prefix of the secret, so a partial guess gains nothing', () => {
    process.env.CRON_SECRET = 'longsecretvalue';
    expect(verifyCronRequest(request('Bearer longsecret'))).toMatchObject({ ok: false, status: 401 });
    expect(verifyCronRequest(request('Bearer longsecretvalueX'))).toMatchObject({ ok: false, status: 401 });
  });

  it('never echoes the expected secret in its error', () => {
    process.env.CRON_SECRET = 'do-not-leak-me';
    const result = verifyCronRequest(request('Bearer nope'));
    expect(JSON.stringify(result)).not.toContain('do-not-leak-me');
  });
});
