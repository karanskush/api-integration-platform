import type { MetadataRoute } from 'next';

const ORIGIN = process.env.PUBLIC_APP_ORIGIN || 'https://www.docentapi.xyz';

// Static surfaces only. Claimed API pages (/[slug]) join once a public
// directory ships — listing them now would put a DB read on every crawl.
export default function sitemap(): MetadataRoute.Sitemap {
  return ['/', '/pricing', '/app'].map((path) => ({
    url: new URL(path, ORIGIN).toString(),
    changeFrequency: 'weekly' as const,
  }));
}
