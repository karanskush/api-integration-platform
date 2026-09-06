import { describe, expect, it } from 'vitest';
import { lifecycleChangeKind, parseLifecycleSignals, parseLinkHeader, pickCapturedHeaders } from '../lifecycle';

function find(headers: Record<string, string>, kind: string) {
  return parseLifecycleSignals(headers).find((s) => s.kind === kind);
}

describe('pickCapturedHeaders', () => {
  it('lowercases names and keeps only the allowlist', () => {
    const headers = new Headers({
      Deprecation: '@1688169599',
      Sunset: 'Wed, 30 Jun 2027 23:59:59 GMT',
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=secret',
      Authorization: 'Bearer nope',
    });
    const picked = pickCapturedHeaders(headers);
    expect(Object.keys(picked).sort()).toEqual(['deprecation', 'sunset']);
    expect(picked.deprecation).toBe('@1688169599');
  });

  it('caps a runaway value so a hostile upstream cannot flood the evidence graph', () => {
    const picked = pickCapturedHeaders(new Headers({ warning: `299 - "${'x'.repeat(2000)}"` }));
    expect(picked.warning.length).toBeLessThanOrEqual(512);
  });
});

describe('parseLinkHeader', () => {
  it('reads several links with quoted and unquoted rels', () => {
    const links = parseLinkHeader('<https://a.example/docs>; rel="deprecation"; type="text/html", <https://b.example/v2>; rel=successor-version');
    expect(links).toEqual([
      { url: 'https://a.example/docs', rel: ['deprecation'] },
      { url: 'https://b.example/v2', rel: ['successor-version'] },
    ]);
  });

  it('handles a multi-token rel and a comma inside the URL', () => {
    const links = parseLinkHeader('<https://a.example/x,y>; rel="sunset deprecation"');
    expect(links).toEqual([{ url: 'https://a.example/x,y', rel: ['sunset', 'deprecation'] }]);
  });

  // A Link URL is attacker-controlled and is stored, then re-served on the
  // public JSON API and to agents. A javascript: URL must never survive the
  // parse boundary.
  it('drops a link whose scheme is not http(s)', () => {
    expect(parseLinkHeader('<javascript:alert(document.domain)>; rel="deprecation"')).toEqual([]);
    expect(parseLinkHeader('<data:text/html,<script>alert(1)</script>>; rel="sunset"')).toEqual([]);
    expect(parseLinkHeader('<file:///etc/passwd>; rel="deprecation"')).toEqual([]);
    // ...and the deprecation signal built from it disappears with it.
    expect(parseLifecycleSignals({ link: '<javascript:alert(1)>; rel="deprecation"' })).toEqual([]);
  });

  it('keeps a relative reference, which cannot carry a scheme', () => {
    expect(parseLinkHeader('</v2/pets>; rel="successor-version"')).toEqual([
      { url: '/v2/pets', rel: ['successor-version'] },
    ]);
  });

  it('bounds the rel tokens on a single link', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `r${i}`).join(' ');
    expect(parseLinkHeader(`<https://a.example>; rel="${many}"`)[0].rel.length).toBeLessThanOrEqual(10);
  });

  it('ignores malformed entries rather than throwing', () => {
    expect(parseLinkHeader('not-a-link, <>; rel=x, <https://ok.example>; rel=sunset')).toEqual([
      { url: 'https://ok.example', rel: ['sunset'] },
    ]);
  });
});

describe('parseLifecycleSignals — Deprecation (RFC 9745)', () => {
  it('reads an RFC 9651 date and converts it to ISO', () => {
    expect(find({ deprecation: '@1688169599' }, 'deprecated')).toMatchObject({
      header: 'deprecation',
      at: '2023-06-30T23:59:59.000Z',
    });
  });

  // Pre-RFC drafts used `true`; the signal is still real, just undated.
  it('accepts the legacy true form without inventing a date', () => {
    const signal = find({ deprecation: 'true' }, 'deprecated');
    expect(signal).toBeDefined();
    expect(signal?.at).toBeUndefined();
  });

  it('accepts an HTTP-date and ignores an unparseable value', () => {
    expect(find({ deprecation: 'Wed, 30 Jun 2027 23:59:59 GMT' }, 'deprecated')?.at).toBe('2027-06-30T23:59:59.000Z');
    expect(find({ deprecation: 'soon' }, 'deprecated')?.at).toBeUndefined();
  });

  it('attaches the rel=deprecation documentation link', () => {
    expect(
      find({ deprecation: '@1688169599', link: '<https://docs.example/deprecations>; rel="deprecation"' }, 'deprecated')?.url,
    ).toBe('https://docs.example/deprecations');
  });

  it('reports a deprecation link on its own, with no Deprecation header', () => {
    expect(find({ link: '<https://docs.example/d>; rel="deprecation"' }, 'deprecated')).toMatchObject({ header: 'link' });
  });
});

describe('parseLifecycleSignals — Sunset (RFC 8594)', () => {
  it('reads the HTTP-date', () => {
    expect(find({ sunset: 'Sat, 31 Dec 2028 23:59:59 GMT' }, 'sunset')?.at).toBe('2028-12-31T23:59:59.000Z');
  });

  it('keeps the raw value when the date will not parse', () => {
    const signal = find({ sunset: 'end of days' }, 'sunset');
    expect(signal?.raw).toBe('end of days');
    expect(signal?.at).toBeUndefined();
  });
});

describe('parseLifecycleSignals — successor, vendor, and version', () => {
  it('reports a successor-version link, falling back to latest-version', () => {
    expect(find({ link: '<https://api.example/v2>; rel="successor-version"' }, 'successor')?.url).toBe('https://api.example/v2');
    expect(find({ link: '<https://api.example/v3>; rel="latest-version"' }, 'successor')?.url).toBe('https://api.example/v3');
  });

  it('reads a 299 Warning only when it actually mentions deprecation', () => {
    expect(find({ warning: '299 - "This endpoint is deprecated"' }, 'vendor_deprecation')).toBeDefined();
    expect(find({ warning: '299 - "Response is stale"' }, 'vendor_deprecation')).toBeUndefined();
    expect(find({ warning: '110 - "deprecated"' }, 'vendor_deprecation')).toBeUndefined();
  });

  it('reads vendor deprecation headers', () => {
    expect(find({ 'x-shopify-api-deprecated-reason': 'https://shopify.dev/changelog/x' }, 'vendor_deprecation')).toBeDefined();
    expect(find({ 'x-api-warn': 'field deprecated, use total_amount' }, 'vendor_deprecation')).toBeDefined();
    expect(find({ 'x-api-warn': 'slow query' }, 'vendor_deprecation')).toBeUndefined();
  });

  it('records version pins from the common vendor headers', () => {
    const signals = parseLifecycleSignals({ 'stripe-version': '2026-04-22', 'x-shopify-api-version': '2026-07' });
    expect(signals.filter((s) => s.kind === 'version').map((s) => s.header).sort()).toEqual(['stripe-version', 'x-shopify-api-version']);
  });

  it('finds nothing in unrelated headers', () => {
    expect(parseLifecycleSignals({ 'x-ratelimit-remaining': '99', 'retry-after': '30' })).toEqual([]);
  });
});

describe('lifecycleChangeKind', () => {
  it('maps deprecation signals to a deprecation change and sunset to a sunset change', () => {
    expect(lifecycleChangeKind({ kind: 'deprecated', header: 'deprecation', raw: 'true' })).toBe('operation.deprecated');
    expect(lifecycleChangeKind({ kind: 'vendor_deprecation', header: 'x-api-warn', raw: 'deprecated' })).toBe('operation.deprecated');
    expect(lifecycleChangeKind({ kind: 'sunset', header: 'sunset', raw: 'x' })).toBe('operation.sunset_scheduled');
  });

  // A version pin and a successor link are context an agent can read, not
  // events in themselves — recording them as changes would spam the changelog
  // on every probe run.
  it('maps version and successor signals to no change at all', () => {
    expect(lifecycleChangeKind({ kind: 'version', header: 'stripe-version', raw: '2026-04-22' })).toBeNull();
    expect(lifecycleChangeKind({ kind: 'successor', header: 'link', raw: 'x', url: 'https://y' })).toBeNull();
  });
});
