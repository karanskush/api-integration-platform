import { beforeEach, describe, expect, it, vi } from 'vitest';
import { crawlDocs, discoverDocSeeds } from '../docsCrawler';

const safeFetchMock = vi.fn();

vi.mock('../ssrf', () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
}));

function htmlResponse(url: string, html: string, contentType = 'text/html') {
  return {
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    body: new TextEncoder().encode(html),
    finalUrl: url,
    latencyMs: 1,
  };
}

describe('discoverDocSeeds', () => {
  it('combines the spec externalDocs url with user-provided ones', () => {
    expect(discoverDocSeeds('https://docs.example.com', ['https://example.com/changelog'])).toEqual([
      'https://docs.example.com',
      'https://example.com/changelog',
    ]);
  });

  it('dedupes and caps at 5', () => {
    const many = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
    expect(discoverDocSeeds(undefined, [...many, ...many])).toHaveLength(5);
  });

  it('tolerates no seeds at all', () => {
    expect(discoverDocSeeds(undefined, [])).toEqual([]);
  });
});

describe('crawlDocs', () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  it('crawls a single seed page with no links', async () => {
    safeFetchMock.mockResolvedValueOnce(
      htmlResponse('https://docs.example.com/', '<html><title>Docs</title><body>Hello world</body></html>'),
    );
    const result = await crawlDocs(['https://docs.example.com/']);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].title).toBe('Docs');
    expect(result.pages[0].text).toContain('Hello world');
    expect(result.truncated).toBe(false);
  });

  it('follows a same-site link within maxDepth', async () => {
    safeFetchMock
      .mockResolvedValueOnce(htmlResponse('https://docs.example.com/', '<a href="/guide">Guide</a>'))
      .mockResolvedValueOnce(htmlResponse('https://docs.example.com/guide', 'Guide content'));
    const result = await crawlDocs(['https://docs.example.com/'], { maxDepth: 2 });
    expect(result.pages.map((p) => p.url)).toEqual(['https://docs.example.com/', 'https://docs.example.com/guide']);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it('never follows a discovered link to a different registrable domain', async () => {
    safeFetchMock.mockResolvedValueOnce(
      htmlResponse('https://docs.example.com/', '<a href="https://attacker.evil.com/steal">bad</a>'),
    );
    const result = await crawlDocs(['https://docs.example.com/']);
    expect(result.pages).toHaveLength(1);
    expect(safeFetchMock).toHaveBeenCalledTimes(1); // the off-domain link was never fetched
  });

  it('treats a subdomain of the same registrable domain as the same site', async () => {
    safeFetchMock
      .mockResolvedValueOnce(htmlResponse('https://docs.example.com/', '<a href="https://api.example.com/reference">ref</a>'))
      .mockResolvedValueOnce(htmlResponse('https://api.example.com/reference', 'Reference content'));
    const result = await crawlDocs(['https://docs.example.com/'], { maxDepth: 2 });
    expect(result.pages).toHaveLength(2);
  });

  it('always fetches the seed itself even when it sits on a shared public hosting zone', async () => {
    safeFetchMock.mockResolvedValueOnce(htmlResponse('https://a.vercel.app/', 'seed content'));
    const result = await crawlDocs(['https://a.vercel.app/']);
    expect(result.pages).toHaveLength(1);
  });

  it('never treats a different tenant on a shared public hosting zone as the same site', async () => {
    safeFetchMock.mockResolvedValueOnce(
      htmlResponse('https://a.vercel.app/', '<a href="https://b.vercel.app/other">other tenant</a>'),
    );
    const result = await crawlDocs(['https://a.vercel.app/']);
    expect(result.pages).toHaveLength(1);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports truncated when the page cap is hit with more frontier left', async () => {
    safeFetchMock.mockImplementation((url: string) =>
      Promise.resolve(htmlResponse(url, `<a href="${url}/a">a</a><a href="${url}/b">b</a>`)),
    );
    const result = await crawlDocs(['https://docs.example.com/'], { maxPages: 1, maxDepth: 2 });
    expect(result.pages).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('reports truncated when the total byte cap is hit', async () => {
    const bigText = 'x'.repeat(1000);
    safeFetchMock
      .mockResolvedValueOnce(htmlResponse('https://docs.example.com/', `<a href="/more">more</a>${bigText}`))
      .mockResolvedValueOnce(htmlResponse('https://docs.example.com/more', bigText));
    const result = await crawlDocs(['https://docs.example.com/'], { maxBytesTotal: 1200, maxDepth: 2 });
    expect(result.truncated).toBe(true);
  });

  it('reports truncated when real links exist beyond the depth cap', async () => {
    safeFetchMock.mockResolvedValueOnce(htmlResponse('https://docs.example.com/', '<a href="/deeper">deeper</a>'));
    const result = await crawlDocs(['https://docs.example.com/'], { maxDepth: 0 });
    expect(result.pages).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips a page whose fetch throws (SSRF-blocked or unreachable) without failing the crawl', async () => {
    safeFetchMock.mockRejectedValueOnce(new Error('blocked'));
    const result = await crawlDocs(['https://docs.example.com/']);
    expect(result.pages).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it('skips non-html/text responses', async () => {
    safeFetchMock.mockResolvedValueOnce(
      htmlResponse('https://docs.example.com/file.pdf', '%PDF-1.4 binary junk', 'application/pdf'),
    );
    const result = await crawlDocs(['https://docs.example.com/file.pdf']);
    expect(result.pages).toHaveLength(0);
  });

  it('returns empty, non-truncated for no seeds', async () => {
    const result = await crawlDocs([]);
    expect(result).toEqual({ pages: [], truncated: false });
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});
