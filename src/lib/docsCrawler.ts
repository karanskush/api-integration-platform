// Provider-docs crawler for the deep-analysis pipeline (the analyze-crawl
// job). Strictly a same-provider-domain crawl seeded from the spec's own
// declared externalDocs.url plus whatever the submitter typed in at
// /analyze — never a general web crawler, and seeds are never invented or
// discovered by searching the internet.
//
// Every fetch goes through the same SSRF guard (safeFetch, which calls
// assertPublicUrl internally) the importer already uses for spec URLs.
//
// Crawled text is untrusted third-party content. Callers MUST treat it
// exactly like spec content already is in ask.ts: pass it through asData()
// before it ever reaches an LLM prompt or a page, and tell the model it is
// data to reason about, never instructions to follow (LLM01).

import { isPublicSuffix } from './claimDomains';
import { safeFetch } from './ssrf';

export type CrawledPage = { url: string; title?: string; text: string };

export type CrawlOptions = {
  maxPages?: number;
  maxBytesTotal?: number;
  maxDepth?: number;
};

export type CrawlResult = {
  pages: CrawledPage[];
  // True whenever a cap actually cut off real work — reported, never
  // silently absorbed, so a truncated crawl is visible in
  // analysis_runs.detail rather than looking like a complete pass.
  truncated: boolean;
};

const MAX_SEEDS = 5;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_BYTES_TOTAL = 2_000_000;
const DEFAULT_MAX_DEPTH = 2;
const PAGE_TIMEOUT_MS = 8_000;
const PAGE_MAX_BYTES = 500_000;
const MAX_TEXT_PER_PAGE = 20_000;

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// The registrable domain a hostname sits under (`docs.stripe.com` ->
// `stripe.com`), reusing claimDomains.ts's public-suffix table so a shared
// hosting zone (`*.vercel.app`, `*.github.io`, ...) never counts as "the same
// site" just because two hostnames happen to share it.
function registrableDomain(host: string): string | null {
  const labels = host.toLowerCase().split('.');
  // Grow the candidate leftward one label at a time, starting from the bare
  // TLD — the first candidate that ISN'T a public suffix is exactly the
  // registrable domain (eTLD+1). Iterating the other direction would test the
  // full hostname first, which is almost never itself a public suffix, and so
  // would return the hostname unchanged instead of stripping to the boundary.
  for (let i = labels.length - 1; i >= 0; i--) {
    const candidate = labels.slice(i).join('.');
    if (!isPublicSuffix(candidate)) return candidate;
  }
  return null;
}

function sameSite(hostA: string, hostB: string): boolean {
  const a = registrableDomain(hostA);
  const b = registrableDomain(hostB);
  return Boolean(a && b && a === b);
}

// Seeds are never invented or searched for — only the spec's own declared
// externalDocs.url and whatever the submitter typed in at /analyze.
export function discoverDocSeeds(externalDocsUrl: string | undefined, userProvidedUrls: string[] = []): string[] {
  const candidates = [...(externalDocsUrl ? [externalDocsUrl] : []), ...userProvidedUrls];
  return dedupe(candidates).slice(0, MAX_SEEDS);
}

const SCRIPT_OR_STYLE = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG = /<[^>]+>/g;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

// Deliberately not a full readability algorithm — good enough to give the
// enrichment pass real prose to reason about, not a pixel-perfect extraction.
function htmlToText(html: string): string {
  const withoutScripts = html.replace(SCRIPT_OR_STYLE, ' ');
  const withoutTags = withoutScripts.replace(TAG, ' ');
  const decoded = withoutTags.replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ENTITIES[name] ?? ' ');
  return decoded.replace(/\s+/g, ' ').trim();
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return match ? htmlToText(match[1]) || undefined : undefined;
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    try {
      const abs = new URL(match[1], baseUrl);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') {
        abs.hash = '';
        links.push(abs.toString());
      }
    } catch {
      // relative to nothing resolvable — skip
    }
  }
  return links;
}

// BFS from `seeds`, staying on the seeds' own registrable domain(s), bounded
// independently on pages, total bytes, and depth — no single axis is allowed
// to run away just because the others haven't been hit yet.
export async function crawlDocs(seeds: string[], opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxBytesTotal = opts.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  const seedHosts = seeds
    .map((s) => {
      try {
        return new URL(s).hostname;
      } catch {
        return null;
      }
    })
    .filter((h): h is string => h !== null);

  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  let bytesUsed = 0;
  let truncated = false;

  const frontier: Array<{ url: string; depth: number }> = dedupe(seeds).map((url) => ({ url, depth: 0 }));

  while (frontier.length) {
    if (pages.length >= maxPages) {
      truncated = true;
      break;
    }
    const next = frontier.shift();
    if (!next) break;
    const { url, depth } = next;
    if (visited.has(url)) continue;
    visited.add(url);

    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    // The seed itself (depth 0) is trusted input — the spec's own declared
    // externalDocs.url or something the submitter explicitly typed in — and
    // is always fetched regardless of what domain it's on (SSRF safety still
    // applies via safeFetch below either way). The same-site check only
    // bounds *expansion*: a link discovered while crawling must stay on one
    // of the seed hosts' registrable domains, or a page could wander onto an
    // attacker's domain, or (for seeds that sit on a shared public hosting
    // zone, e.g. bare *.vercel.app) onto a different tenant entirely.
    if (depth > 0 && !seedHosts.some((seedHost) => sameSite(host, seedHost))) continue;

    let result;
    try {
      result = await safeFetch(url, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES });
    } catch {
      continue; // one unreachable/blocked page doesn't fail the whole crawl
    }
    if (result.status >= 400) continue;
    const contentType = result.headers.get('content-type') ?? '';
    if (!contentType.includes('html') && !contentType.includes('text')) continue;

    const html = new TextDecoder().decode(result.body);
    const text = htmlToText(html).slice(0, MAX_TEXT_PER_PAGE);
    if (!text) continue;

    if (bytesUsed + text.length > maxBytesTotal) {
      truncated = true;
      break;
    }
    bytesUsed += text.length;
    pages.push({ url: result.finalUrl, title: extractTitle(html), text });

    if (depth < maxDepth) {
      for (const link of extractLinks(html, result.finalUrl)) {
        if (!visited.has(link)) frontier.push({ url: link, depth: depth + 1 });
      }
    } else if (extractLinks(html, result.finalUrl).length) {
      truncated = true; // real links existed beyond the depth cap
    }
  }

  return { pages, truncated };
}
