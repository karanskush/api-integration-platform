import { slugify, uniqueSlug } from './slugify';

// Top-level static routes that a persistent API slug (served at /[slug]) must
// never collide with. Next.js resolves a literal segment (e.g. /pricing)
// before a dynamic sibling at the same depth, so a colliding slug would just
// be permanently unreachable rather than break routing — this blocklist
// stops that outcome before it happens.
const RESERVED_SLUGS = new Set([
  'app',
  'api',
  'p',
  'mcp',
  'pricing',
  'dashboard',
  'sign-in',
  'sign-up',
  'badge',
]);

export async function allocateApiSlug(
  name: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  return uniqueSlug(name, async (candidate) => RESERVED_SLUGS.has(candidate) || (await exists(candidate)));
}

export { slugify };
