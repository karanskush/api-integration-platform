import { describe, expect, it } from 'vitest';
import { apiHostnames, checkClaimDomain, claimableDomains, isPublicSuffix } from '../claimDomains';

describe('isPublicSuffix', () => {
  it('treats a bare TLD as a public suffix', () => {
    expect(isPublicSuffix('com')).toBe(true);
    expect(isPublicSuffix('io')).toBe(true);
    expect(isPublicSuffix('dev')).toBe(true);
  });

  it('treats multi-label ccTLD patterns as public suffixes', () => {
    expect(isPublicSuffix('co.uk')).toBe(true);
    expect(isPublicSuffix('com.au')).toBe(true);
    expect(isPublicSuffix('co.jp')).toBe(true);
  });

  it('does not treat a registrable name under a ccTLD pattern as a public suffix', () => {
    expect(isPublicSuffix('example.co.uk')).toBe(false);
    expect(isPublicSuffix('mycompany.com.au')).toBe(false);
  });

  it('treats hosting zones and everything beneath them as public suffixes', () => {
    expect(isPublicSuffix('vercel.app')).toBe(true);
    expect(isPublicSuffix('github.io')).toBe(true);
    expect(isPublicSuffix('amazonaws.com')).toBe(true);
    expect(isPublicSuffix('execute-api.us-east-1.amazonaws.com')).toBe(true);
    expect(isPublicSuffix('s3.amazonaws.com')).toBe(true);
  });

  it('accepts an ordinary registrable domain', () => {
    expect(isPublicSuffix('stripe.com')).toBe(false);
    expect(isPublicSuffix('api.stripe.com')).toBe(false);
  });

  it('ignores a trailing dot and case', () => {
    expect(isPublicSuffix('CO.UK.')).toBe(true);
  });
});

describe('apiHostnames', () => {
  it('extracts hostnames from base urls', () => {
    expect(apiHostnames({ baseUrls: ['https://api.example.com/v1', 'https://eu.example.com'] })).toEqual([
      'api.example.com',
      'eu.example.com',
    ]);
  });

  it('includes the spec source url host', () => {
    expect(
      apiHostnames({ baseUrls: [], sourceUrl: 'https://docs.example.com/openapi.json' }),
    ).toEqual(['docs.example.com']);
  });

  it('tolerates scheme-less base urls', () => {
    expect(apiHostnames({ baseUrls: ['api.example.com/v1'] })).toEqual(['api.example.com']);
  });

  it('dedupes repeated hosts', () => {
    expect(
      apiHostnames({ baseUrls: ['https://api.example.com/v1', 'https://api.example.com/v2'] }),
    ).toEqual(['api.example.com']);
  });

  it('drops IP literals, which have no domain to prove', () => {
    expect(apiHostnames({ baseUrls: ['https://93.184.216.34/v1', 'https://[2606:2800::1]/v1'] })).toEqual([]);
  });

  it('drops single-label hosts', () => {
    expect(apiHostnames({ baseUrls: ['https://localhost:3000', 'https://internal-api'] })).toEqual([]);
  });

  it('drops unparseable entries and non-strings', () => {
    expect(apiHostnames({ baseUrls: ['', ' ', 42, null, 'https://ok.example.com'] })).toEqual([
      'ok.example.com',
    ]);
  });

  it('returns an empty list when there is nothing to derive a host from', () => {
    expect(apiHostnames({ baseUrls: [], sourceUrl: null })).toEqual([]);
    expect(apiHostnames({})).toEqual([]);
  });
});

describe('claimableDomains', () => {
  it('offers the exact host and its registrable parent', () => {
    expect(claimableDomains(['api.stripe.com'])).toEqual(['api.stripe.com', 'stripe.com']);
  });

  it('offers every registrable parent of a deep host, most specific first', () => {
    expect(claimableDomains(['v1.api.eu.example.com'])).toEqual([
      'v1.api.eu.example.com',
      'api.eu.example.com',
      'eu.example.com',
      'example.com',
    ]);
  });

  it('stops at the public-suffix boundary for a ccTLD pattern', () => {
    const allowed = claimableDomains(['api.example.co.uk']);
    expect(allowed).toContain('api.example.co.uk');
    expect(allowed).toContain('example.co.uk');
    expect(allowed).not.toContain('co.uk');
  });

  it('offers only the exact host inside a hosting zone', () => {
    expect(claimableDomains(['my-api.vercel.app'])).toEqual(['my-api.vercel.app']);
    expect(claimableDomains(['abc123.execute-api.us-east-1.amazonaws.com'])).toEqual([
      'abc123.execute-api.us-east-1.amazonaws.com',
    ]);
  });

  it('merges the candidates from several hosts', () => {
    const allowed = claimableDomains(['api.example.com', 'cdn.other.org']);
    expect(allowed).toContain('example.com');
    expect(allowed).toContain('other.org');
  });
});

describe('checkClaimDomain', () => {
  const api = { baseUrls: ['https://api.example.com/v1'], sourceUrl: 'https://docs.example.com/spec.json' };

  it('allows the exact base-url host', () => {
    expect(checkClaimDomain('api.example.com', api)).toEqual({ ok: true });
  });

  it('allows the registrable parent shared by the base url and the spec host', () => {
    expect(checkClaimDomain('example.com', api)).toEqual({ ok: true });
  });

  it('allows the spec source host', () => {
    expect(checkClaimDomain('docs.example.com', api)).toEqual({ ok: true });
  });

  // The vulnerability this gate exists to close: proving control of a domain
  // you already own must not transfer ownership of someone else's page.
  it('rejects an unrelated attacker-controlled domain', () => {
    const result = checkClaimDomain('attacker.example', api);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unrelated');
      expect(result.allowed).toContain('example.com');
    }
  });

  it('rejects a sibling domain that merely looks similar', () => {
    expect(checkClaimDomain('example.com.attacker.test', api).ok).toBe(false);
    expect(checkClaimDomain('notexample.com', api).ok).toBe(false);
  });

  it('rejects a subdomain of an allowed domain that the API never declared', () => {
    // Control of api.example.com does not imply control of evil.api.example.com
    // in the other direction, and the API never declared this host.
    expect(checkClaimDomain('evil.api.example.com', api).ok).toBe(false);
  });

  it('rejects the public suffix above the API host', () => {
    const hosted = { baseUrls: ['https://my-api.vercel.app'] };
    expect(checkClaimDomain('vercel.app', hosted).ok).toBe(false);
    expect(checkClaimDomain('my-api.vercel.app', hosted)).toEqual({ ok: true });
  });

  it('reports no_hostnames when the API declared nothing to prove against', () => {
    const result = checkClaimDomain('example.com', { baseUrls: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_hostnames');
  });

  it('ignores case and a trailing dot in the requested domain', () => {
    expect(checkClaimDomain('API.Example.COM.', api)).toEqual({ ok: true });
  });
});
