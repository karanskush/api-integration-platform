import type { MetadataRoute } from 'next';

const ORIGIN = process.env.PUBLIC_APP_ORIGIN || 'https://www.docentapi.xyz';

// Public surfaces are crawlable; machine endpoints (/api, /mcp), ephemeral
// workspaces (/p — they also carry a noindex meta), and account rooms are
// not. Claimed API pages (/[slug]) stay crawlable: they are the product's
// public output.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/mcp/', '/p/', '/dashboard', '/sign-in', '/sign-up'],
    },
    sitemap: `${ORIGIN}/sitemap.xml`,
  };
}
