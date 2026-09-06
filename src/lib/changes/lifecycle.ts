// Lifecycle signals carried on HTTP response headers.
//
// Every probe and every MCP call already receives these headers and, until
// now, threw them away. They are the cheapest change signal the platform has:
// zero extra requests, and the provider is the one asserting them.
//
//   Deprecation  RFC 9745 — an RFC 9651 Date (`@<unix seconds>`); a past date
//                means "already deprecated". Pre-RFC drafts used `true` or an
//                HTTP-date; both are tolerated so real-world APIs still count.
//   Sunset       RFC 8594 — an HTTP-date after which the resource goes away.
//                A hint, not a guarantee (the RFC says so); recorded as such.
//   Link         RFC 8288 — rel="deprecation" (RFC 9745, human docs about the
//                deprecation), rel="sunset" (RFC 8594, retirement policy),
//                rel="successor-version" / "latest-version" (RFC 5829).
//   Warning 299  the pre-RFC convention for free-text deprecation notices.
//   Vendor       Shopify's X-Shopify-API-Deprecated-Reason, X-API-Warn, and
//                the version-pinning headers Stripe/Shopify/others emit.
//
// Everything here is pure string parsing over an allowlisted, size-capped
// header map. Third-party header values are data (OWASP LLM01): they are
// stored as short raw strings and never interpreted as instructions.

import type { ChangeKind } from './diff';

export const CAPTURED_HEADERS = [
  'deprecation',
  'sunset',
  'link',
  'warning',
  'api-version',
  'x-api-version',
  'stripe-version',
  'x-shopify-api-version',
  'x-shopify-api-deprecated-reason',
  'x-api-warn',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'ratelimit-policy',
  'retry-after',
] as const;

const CAPTURED = new Set<string>(CAPTURED_HEADERS);

// Long enough for a multi-link Link header, short enough that a hostile
// upstream cannot stuff kilobytes of prose into the evidence graph per call.
const MAX_VALUE_CHARS = 512;
const MAX_LINK_HEADER_CHARS = 4096;
const MAX_LINKS = 20;
const MAX_RELS_PER_LINK = 10;

// A Link URL is attacker-controlled: it comes from a provider response, is
// stored in the ledger, and is served back on the public JSON API and to
// agents. Anything with a scheme other than http(s) — `javascript:` above all
// — is dropped at the parse boundary rather than trusted downstream, the same
// rule assertPublicUrl applies to outbound fetches.
//
// A relative reference (`</v2>`) has no scheme and cannot parse as an absolute
// URL, so it is kept: `javascript:alert(1)` always parses absolute and is
// always rejected.
function isSafeLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return true; // relative reference
  }
}

// Lowercased, allowlisted, capped. Accepts the Headers a safeFetch result
// carries; the probes and invokeAction pass the result straight through.
export function pickCapturedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (!CAPTURED.has(key)) return;
    const limit = key === 'link' ? MAX_LINK_HEADER_CHARS : MAX_VALUE_CHARS;
    out[key] = value.length > limit ? value.slice(0, limit) : value;
  });
  return out;
}

export type LifecycleSignalKind = 'deprecated' | 'sunset' | 'successor' | 'vendor_deprecation' | 'version';

export type LifecycleSignal = {
  kind: LifecycleSignalKind;
  header: string; // which header carried it, lowercase
  raw: string; // the header value as received (capped)
  at?: string; // ISO timestamp when the header carried a date
  url?: string; // documentation / successor URL from a Link relation
};

export type ParsedLink = { url: string; rel: string[] };

// RFC 8288 link-value list: `<url>; rel="a b"; type=x, <url2>; rel=next`.
// Splits on commas that are outside <> and outside quotes, then reads the
// URI-Reference and the rel parameter. Other parameters are ignored.
export function parseLinkHeader(value: string): ParsedLink[] {
  const text = value.length > MAX_LINK_HEADER_CHARS ? value.slice(0, MAX_LINK_HEADER_CHARS) : value;
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') depth++;
    else if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && !quoted && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);

  const links: ParsedLink[] = [];
  for (const part of parts) {
    if (links.length >= MAX_LINKS) break;
    const match = part.match(/^\s*<([^>]*)>\s*(.*)$/s);
    if (!match) continue;
    const url = match[1].trim();
    if (!url || !isSafeLinkUrl(url)) continue;
    const rel: string[] = [];
    for (const param of match[2].split(';')) {
      const [name, ...rest] = param.split('=');
      if (name.trim().toLowerCase() !== 'rel') continue;
      const rawRel = rest.join('=').trim().replace(/^"(.*)"$/s, '$1');
      for (const r of rawRel.split(/\s+/)) {
        if (!r) continue;
        if (rel.length >= MAX_RELS_PER_LINK) break;
        rel.push(r.toLowerCase());
      }
    }
    links.push({ url, rel });
  }
  return links;
}

// RFC 9651 Date (`@1688169599`), or the tolerated legacy forms.
function parseDeprecationDate(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith('@')) {
    const seconds = Number(value.slice(1));
    if (Number.isFinite(seconds) && Math.abs(seconds) < 1e11) return new Date(seconds * 1000).toISOString();
    return undefined;
  }
  return parseHttpDate(value);
}

function parseHttpDate(raw: string): string | undefined {
  const at = Date.parse(raw.trim());
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

const DEPRECATION_WORDS = /deprecat/i;
const VERSION_HEADERS = ['api-version', 'x-api-version', 'stripe-version', 'x-shopify-api-version'];

export function parseLifecycleSignals(headers: Record<string, string>): LifecycleSignal[] {
  const signals: LifecycleSignal[] = [];
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') lower[k.toLowerCase()] = v;

  const links = lower.link ? parseLinkHeader(lower.link) : [];
  const linkFor = (rel: string) => links.find((l) => l.rel.includes(rel))?.url;

  if (lower.deprecation !== undefined) {
    const at = parseDeprecationDate(lower.deprecation);
    const url = linkFor('deprecation');
    signals.push({ kind: 'deprecated', header: 'deprecation', raw: lower.deprecation, ...(at ? { at } : {}), ...(url ? { url } : {}) });
  } else if (linkFor('deprecation')) {
    // A deprecation link with no Deprecation header still says "this is going
    // away" — record it, without a date.
    signals.push({ kind: 'deprecated', header: 'link', raw: lower.link, url: linkFor('deprecation') });
  }

  if (lower.sunset !== undefined) {
    const at = parseHttpDate(lower.sunset);
    const url = linkFor('sunset');
    signals.push({ kind: 'sunset', header: 'sunset', raw: lower.sunset, ...(at ? { at } : {}), ...(url ? { url } : {}) });
  } else if (linkFor('sunset')) {
    signals.push({ kind: 'sunset', header: 'link', raw: lower.link, url: linkFor('sunset') });
  }

  const successor = linkFor('successor-version') ?? linkFor('latest-version');
  if (successor) signals.push({ kind: 'successor', header: 'link', raw: lower.link, url: successor });

  if (lower.warning && /^\s*299\b/.test(lower.warning) && DEPRECATION_WORDS.test(lower.warning)) {
    signals.push({ kind: 'vendor_deprecation', header: 'warning', raw: lower.warning });
  }
  if (lower['x-shopify-api-deprecated-reason']) {
    signals.push({ kind: 'vendor_deprecation', header: 'x-shopify-api-deprecated-reason', raw: lower['x-shopify-api-deprecated-reason'] });
  }
  if (lower['x-api-warn'] && DEPRECATION_WORDS.test(lower['x-api-warn'])) {
    signals.push({ kind: 'vendor_deprecation', header: 'x-api-warn', raw: lower['x-api-warn'] });
  }

  for (const header of VERSION_HEADERS) {
    if (lower[header]) signals.push({ kind: 'version', header, raw: lower[header] });
  }

  return signals;
}

// Which ledger row a signal becomes. Version pins and successor links are
// evidence (an agent can read them) but not changes in themselves.
export function lifecycleChangeKind(signal: LifecycleSignal): ChangeKind | null {
  switch (signal.kind) {
    case 'deprecated':
    case 'vendor_deprecation':
      return 'operation.deprecated';
    case 'sunset':
      return 'operation.sunset_scheduled';
    default:
      return null;
  }
}
