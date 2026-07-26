// Domain-ownership verification for claiming an existing unclaimed API page
// (Spotcheck-seeded or created by another user) — distinct from
// api/apis/claim/route.ts, which claims a fresh ephemeral import into the
// caller's own account and never touches this file.

import { promises as dns } from 'node:dns';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Db } from './db';
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

export type ApplyClaimResult = 'ok' | 'over_limit' | 'already_claimed';

// Transfers an unclaimed API to the verifying org.
//
// The ownership transfer is a single conditional UPDATE guarded on
// `claim_status = 'unclaimed'`, which is what makes it safe. Two things go
// wrong with a read-then-write version:
//
//   * two claimants verifying the same page concurrently both see
//     "unclaimed" and both transfer it, last writer winning silently;
//   * a claim started while a page was unclaimed still verifies *after*
//     somebody else has claimed it, quietly stealing an owned page.
//
// Concurrent UPDATEs against the same row serialize in Postgres and the
// loser re-checks the guard against the committed row, so exactly one
// transfer can win and a stale claim finds the page already claimed.
//
// The plan cap rides along in the same statement's WHERE. Under READ
// COMMITTED two claims of *different* pages can still each see a
// pre-transfer count and both pass, so the cap is a best-effort business
// limit rather than a hard invariant — it self-heals on the next claim, and
// unlike ownership it has no security consequence.
export async function applyClaimVerification(
  db: Db,
  input: ApplyClaimVerificationInput,
): Promise<ApplyClaimResult> {
  const { claimId, apiId, orgId, createdBy } = input;

  const [org] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const limit = limitsFor(org?.plan ?? 'free').maxPersistentApis;

  const transferred = await db
    .update(apis)
    .set({ claimStatus: 'claimed', orgId, createdBy, updatedAt: new Date() })
    .where(
      and(
        eq(apis.id, apiId),
        eq(apis.claimStatus, 'unclaimed'),
        sql`(select count(*) from ${apis} as cap where cap.org_id = ${orgId}) < ${limit}`,
      ),
    )
    .returning({ id: apis.id });

  if (!transferred.length) {
    // Distinguish the two rejection causes for the caller's error message.
    const [current] = await db
      .select({ claimStatus: apis.claimStatus })
      .from(apis)
      .where(eq(apis.id, apiId))
      .limit(1);
    return current && current.claimStatus !== 'unclaimed' ? 'already_claimed' : 'over_limit';
  }

  await db
    .update(claims)
    .set({ status: 'verified' })
    .where(and(eq(claims.id, claimId), eq(claims.status, 'pending')));

  // Any other claim still pending on this page can never succeed now that the
  // page is owned — retire them so a stale row can't be replayed later.
  await db
    .update(claims)
    .set({ status: 'superseded' })
    .where(and(eq(claims.apiId, apiId), eq(claims.status, 'pending'), ne(claims.id, claimId)));

  return 'ok';
}
