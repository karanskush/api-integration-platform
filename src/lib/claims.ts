// Domain-ownership verification for claiming an existing unclaimed API page
// (Spotcheck-seeded or created by another user) — distinct from
// api/apis/claim/route.ts, which claims a fresh ephemeral import into the
// caller's own account and never touches this file.

import { promises as dns } from 'node:dns';
import { eq, sql } from 'drizzle-orm';
import type { NeonDb } from './db';
import { apis, claims, orgs } from './db/schema';
import { limitsFor } from './plans';
import { safeFetch } from './ssrf';

export type DnsResolver = (hostname: string) => Promise<string[]>;

async function defaultResolver(hostname: string): Promise<string[]> {
  try {
    const records = await dns.resolveTxt(hostname);
    return records.flat();
  } catch {
    return [];
  }
}

export async function verifyDnsClaim(
  domain: string,
  token: string,
  resolveTxt: DnsResolver = defaultResolver,
): Promise<boolean> {
  try {
    const records = await resolveTxt(`_spotcheck-verify.${domain}`);
    return records.some((record) => record.includes(token));
  } catch {
    return false;
  }
}

type FetchImpl = typeof safeFetch;

// Tolerant of attribute order (name/content can appear in either order) —
// not a full HTML parser, just a per-tag substring check.
function hasVerificationMetaTag(html: string, token: string): boolean {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameAttr = /name\s*=\s*["']spotcheck-verification["']/i;
  const contentAttr = new RegExp(`content\\s*=\\s*["']${escapedToken}["']`, 'i');
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (nameAttr.test(tag) && contentAttr.test(tag)) return true;
  }
  return false;
}

export async function verifyMetaClaim(
  domain: string,
  token: string,
  fetchImpl: FetchImpl = safeFetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`https://${domain}/`, { timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 });
    const html = new TextDecoder().decode(res.body);
    return hasVerificationMetaTag(html, token);
  } catch {
    return false;
  }
}

// Subdomains inherit control of their parent domain, so an account on
// eng.example.com can claim a page whose target domain is example.com.
export function verifyEmailClaim(userEmail: string, domain: string): boolean {
  const at = userEmail.lastIndexOf('@');
  if (at === -1) return false;
  const emailDomain = userEmail.slice(at + 1).toLowerCase();
  const target = domain.toLowerCase();
  return emailDomain === target || emailDomain.endsWith(`.${target}`);
}

export type ApplyClaimVerificationInput = {
  claimId: string;
  apiId: string;
  orgId: string;
  createdBy: string;
};

// Mirrors api/apis/claim/route.ts's maxPersistentApis cap check exactly, but
// resolves the org's plan itself since callers here only have an orgId.
export async function applyClaimVerification(
  db: NeonDb,
  input: ApplyClaimVerificationInput,
): Promise<'ok' | 'over_limit'> {
  const { claimId, apiId, orgId, createdBy } = input;

  const [org] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apis)
    .where(eq(apis.orgId, orgId));
  const limit = limitsFor(org?.plan ?? 'free').maxPersistentApis;
  if (count >= limit) return 'over_limit';

  await db.batch([
    db.update(claims).set({ status: 'verified' }).where(eq(claims.id, claimId)),
    db.update(apis).set({ claimStatus: 'claimed', orgId, createdBy }).where(eq(apis.id, apiId)),
  ]);
  return 'ok';
}
