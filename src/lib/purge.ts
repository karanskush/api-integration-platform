// One place that knows every cached surface an API owns.
//
// Six write paths purge after a change, and each was maintaining its own pair
// of revalidatePath() calls. Adding the changelog, its feed, and the badge
// manifest to six separate lists is how a surface ends up stale on one path
// and fresh on another — the exact failure the version fence exists to stop,
// reintroduced through the cache.
//
// Imports next/cache, so this file is for route handlers and server
// components only. Library modules under test (reverify.ts, specPoll.ts) must
// NOT import it: their callers do the purging.

import { revalidatePath } from 'next/cache';

export function apiSurfacePaths(slug: string): string[] {
  return [
    `/${slug}`,
    `/${slug}/changes`,
    `/${slug}/changes/feed.xml`,
    `/badge/${slug}`,
    `/badge/${slug}/manifest.json`,
  ];
}

export function purgeApiSurfaces(slug: string): void {
  for (const path of apiSurfacePaths(slug)) revalidatePath(path);
}
