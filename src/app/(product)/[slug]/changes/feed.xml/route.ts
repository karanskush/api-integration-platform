import { buildRssFeed, type FeedItem } from '@/lib/changes/feed';
import { groupIntoReleases, listChanges } from '@/lib/changes/query';
import { formatUtcDate } from '@/lib/changes/time';
import { dbReady, getDb } from '@/lib/db';
import { appOrigin } from '@/lib/origin';
import { apiVisibility } from '@/lib/visibility';

// Cached and purgeable, like the badge: a feed reader polls far more often
// than an API changes, and purgeApiSurfaces() includes this path.
export const revalidate = 3600;

const FEED_LIMIT = 100;

// One RSS item per release, so a subscriber gets "this version changed these
// things" rather than a row per field.
//
// Unauthenticated and CDN-cached, so there is no caller identity to check: a
// private API simply has no feed, 404, exactly like its badge.
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!dbReady()) return new Response('Not found', { status: 404 });

  const visibility = await apiVisibility(slug);
  if (!visibility.exists || visibility.private || !visibility.apiId) {
    return new Response('Not found', { status: 404 });
  }

  const origin = appOrigin();
  const pageUrl = `${origin}/${slug}`;
  const releases = groupIntoReleases(await listChanges(getDb(), visibility.apiId, { limit: FEED_LIMIT }));

  const items: FeedItem[] = releases.map((release) => {
    const headline = (Object.keys(release.counts) as Array<keyof typeof release.counts>)
      .filter((s) => release.counts[s] > 0)
      .map((s) => `${release.counts[s]} ${s}`)
      .join(', ');
    return {
      title: `${slug}: ${headline} on ${formatUtcDate(release.observedAt)}`,
      link: `${pageUrl}/changes`,
      guid: release.key,
      pubDate: new Date(release.observedAt),
      description: release.changes.map((c) => `[${c.severity}] ${c.summary}`).join('\n'),
    };
  });

  const body = buildRssFeed({
    title: `${slug} — API changes`,
    link: `${pageUrl}/changes`,
    description: `Classified changes to the ${slug} API contract, detected by DocentAPI.`,
    items,
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
