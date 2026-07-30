import { afterEach, describe, expect, it } from 'vitest';
import { appHost, appOrigin } from '../origin';

const ENV = process.env.PUBLIC_APP_ORIGIN;
afterEach(() => {
  if (ENV === undefined) delete process.env.PUBLIC_APP_ORIGIN;
  else process.env.PUBLIC_APP_ORIGIN = ENV;
});

function withOrigin(value: string | undefined) {
  if (value === undefined) delete process.env.PUBLIC_APP_ORIGIN;
  else process.env.PUBLIC_APP_ORIGIN = value;
}

describe('appOrigin', () => {
  it('prefers the configured origin over the request', () => {
    withOrigin('https://docentapi.dev');
    // The request origin is wrong behind a proxy and on preview URLs, which is
    // the whole reason the env var exists.
    expect(appOrigin(new Request('https://internal-7x2.vercel.app/api/import'))).toBe(
      'https://docentapi.dev',
    );
  });

  it.each(['https://docentapi.dev/', 'https://docentapi.dev///', '  https://docentapi.dev/  '])(
    'normalises %j to a bare origin',
    (configured) => {
      withOrigin(configured);
      expect(appOrigin()).toBe('https://docentapi.dev');
    },
  );

  it('falls back to the serving request when unset', () => {
    withOrigin(undefined);
    expect(appOrigin(new Request('https://example.test/p/abc?x=1'))).toBe('https://example.test');
  });

  it('falls back to localhost with neither', () => {
    withOrigin(undefined);
    expect(appOrigin()).toBe('http://localhost:3000');
  });

  it('treats an empty or whitespace value as unset', () => {
    withOrigin('   ');
    expect(appOrigin()).toBe('http://localhost:3000');
  });
});

describe('appHost', () => {
  it.each([
    ['https://docentapi.dev', 'docentapi.dev'],
    ['http://localhost:3000', 'localhost:3000'],
    ['https://docentapi.vercel.app/', 'docentapi.vercel.app'],
  ])('%s -> %s', (configured, expected) => {
    withOrigin(configured);
    expect(appHost()).toBe(expected);
  });

  it('is what the landing copy renders, so it never carries a scheme', () => {
    withOrigin('https://docentapi.dev');
    // Copy reads "docentapi.dev/mcp/you", never "https://docentapi.dev/mcp/you".
    expect(appHost()).not.toMatch(/^https?:/);
  });
});
