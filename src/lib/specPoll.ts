// Scheduled spec polling: the loop that makes "our page already knows" true
// for a provider who changes their spec and tells nobody.
//
// Before this, a spec change reached DocentAPI only if the provider had wired
// up the CI action (api/ci/sync) or was on the plan with weekly
// re-verification. Everyone else's page kept describing a contract that had
// moved on. This polls the spec's own source URL on a per-plan cadence, for
// every plan, and routes any change through the same reimport path — which now
// diffs it and writes the classified result to the ledger.
//
// CONDITIONAL GET is what makes that affordable. RFC 9110 §13: send the stored
// ETag as If-None-Match (and Last-Modified as If-Modified-Since), and an
// unchanged spec answers 304 with no body. Content-hash dedup already made an
// unchanged spec cheap to STORE; this makes it cheap to FETCH.
//
// A spec pushed as text through CI has no source_url and is deliberately
// skipped: CI owns that API's freshness and polling it would fetch nothing.

import { and, asc, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { ChangeSet, Severity } from './changes/diff';
import type { Db, NeonDb } from './db';
import { apis, orgs, specVersions } from './db/schema';
import { runImport } from './importer';
import { reimportApi } from './persist';
import { SsrfError, UpstreamError, safeFetch } from './ssrf';

const MAX_SPEC_BYTES = 5 * 1024 * 1024;
const PAID_PLANS = ['launch', 'pro', 'team', 'business'];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Detection runs for every plan — freshness is the product's whole claim, and
// a free page that silently rots undermines it. Cadence is the paid dial.
export function pollIntervalHours(plan: string): number {
  return PAID_PLANS.includes(plan) ? envInt('SPEC_POLL_INTERVAL_HOURS', 1) : envInt('SPEC_POLL_INTERVAL_HOURS_FREE', 24);
}

// Bounded per invocation: each candidate is a real outbound request and the
// function has a wall clock, so one run takes a batch of the stalest rather
// than sweeping everything and timing out halfway (same shape as reverify).
export function pollBatchSize(): number {
  return Math.min(100, envInt('SPEC_POLL_BATCH', 20));
}

export type SpecFetchResult =
  | { status: 'not_modified' }
  | { status: 'ok'; text: string; etag?: string; lastModified?: string; finalUrl: string }
  | { status: 'failed'; reason: string };

export type FetchImpl = typeof safeFetch;

export async function fetchSpecConditional(
  url: string,
  validators: { etag?: string | null; lastModified?: string | null },
  fetchImpl: FetchImpl = safeFetch,
): Promise<SpecFetchResult> {
  const headers: Record<string, string> = {
    accept: 'application/json, application/yaml, text/yaml, text/plain, */*',
  };
  // If-None-Match takes precedence over If-Modified-Since when both are sent
  // (RFC 9110 §13.1.3), so sending both is safe and strictly more likely to
  // earn a 304 from a server that supports only one.
  if (validators.etag) headers['if-none-match'] = validators.etag;
  if (validators.lastModified) headers['if-modified-since'] = validators.lastModified;

  try {
    const res = await fetchImpl(url, { timeoutMs: 10_000, maxBytes: MAX_SPEC_BYTES, headers });
    if (res.status === 304) return { status: 'not_modified' };
    if (res.status >= 400) return { status: 'failed', reason: `http_${res.status}` };
    return {
      status: 'ok',
      text: new TextDecoder().decode(res.body),
      etag: res.headers.get('etag') ?? undefined,
      lastModified: res.headers.get('last-modified') ?? undefined,
      finalUrl: res.finalUrl,
    };
  } catch (err) {
    // Never the message: an upstream error string can echo provider content.
    if (err instanceof SsrfError || err instanceof UpstreamError) return { status: 'failed', reason: err.name };
    return { status: 'failed', reason: err instanceof Error ? err.name : 'unknown' };
  }
}

export type PollCandidate = {
  apiId: string;
  slug: string;
  orgId: string;
  plan: string;
  specVersionId: string;
  sourceUrl: string;
  etag: string | null;
  lastModified: string | null;
  lastPolledAt: Date | null;
};

export async function findPollCandidates(db: Db, limit = pollBatchSize(), now = new Date()): Promise<PollCandidate[]> {
  const paidBefore = new Date(now.getTime() - pollIntervalHours('pro') * 3600 * 1000).toISOString();
  const freeBefore = new Date(now.getTime() - pollIntervalHours('free') * 3600 * 1000).toISOString();

  const rows = await db
    .select({
      apiId: apis.id,
      slug: apis.slug,
      orgId: apis.orgId,
      plan: orgs.plan,
      specVersionId: specVersions.id,
      sourceUrl: specVersions.sourceUrl,
      etag: specVersions.etag,
      lastModified: specVersions.lastModified,
      lastPolledAt: specVersions.lastPolledAt,
    })
    .from(apis)
    .innerJoin(orgs, eq(orgs.id, apis.orgId))
    .innerJoin(specVersions, eq(specVersions.id, apis.currentSpecVersionId))
    .where(
      and(
        eq(apis.claimStatus, 'claimed'),
        isNotNull(specVersions.sourceUrl),
        or(
          // A plan we do not recognise gets the free cadence rather than the
          // paid one — an unknown string must not buy a faster poll.
          and(
            sql`${orgs.plan} in ${PAID_PLANS}`,
            sql`coalesce(${specVersions.lastPolledAt}, '-infinity'::timestamptz) < ${paidBefore}`,
          ),
          and(
            sql`${orgs.plan} not in ${PAID_PLANS}`,
            sql`coalesce(${specVersions.lastPolledAt}, '-infinity'::timestamptz) < ${freeBefore}`,
          ),
        ),
      ),
    )
    // Never-polled first, then longest-unpolled: with a bounded batch this is
    // what stops one API monopolising the queue.
    .orderBy(asc(sql`coalesce(${specVersions.lastPolledAt}, '-infinity'::timestamptz)`))
    .limit(limit);

  return rows.filter((r): r is PollCandidate => typeof r.sourceUrl === 'string');
}

// What the poll DID, reported to the cron caller.
export type PollStatus = 'unchanged' | 'updated' | 'reverted' | 'not_modified' | 'failed' | 'unsupported';

// What the FETCH returned, stored on spec_versions.poll_status. Deliberately a
// narrower vocabulary than PollStatus: the column answers "could we read the
// spec last time we looked", not "did the contract move".
export type StoredPollStatus = 'ok' | 'not_modified' | 'failed' | 'unsupported';

export type PollOutcome = {
  slug: string;
  status: PollStatus;
  counts?: Record<Severity, number>;
  highest?: Severity | null;
  error?: string;
};

export type PollDeps = {
  fetchSpec?: typeof fetchSpecConditional;
  importSpec?: typeof runImport;
  now?: () => Date;
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Never throws: one unreachable provider must not abort the batch.
export async function pollOne(db: NeonDb, candidate: PollCandidate, deps: PollDeps = {}): Promise<PollOutcome> {
  const fetchSpec = deps.fetchSpec ?? fetchSpecConditional;
  const importSpec = deps.importSpec ?? runImport;

  // EVERY branch below stamps last_polled_at. Without that, a spec that 404s
  // forever sits at the head of the stalest-first queue and starves the rest.
  //
  // The timestamp is read when the row is WRITTEN, not when the poll started:
  // a fetch takes seconds, and stamping the start time makes "last checked"
  // read as earlier than the version that same poll just created — a freshness
  // line that contradicts itself.
  const markPolled = async (specVersionId: string, fields: { pollStatus: StoredPollStatus; pollError?: string | null; etag?: string | null; lastModified?: string | null }) => {
    await db
      .update(specVersions)
      .set({ lastPolledAt: deps.now?.() ?? new Date(), pollError: null, ...fields })
      .where(eq(specVersions.id, specVersionId));
  };

  if (!isHttpUrl(candidate.sourceUrl)) {
    await markPolled(candidate.specVersionId, { pollStatus: 'unsupported' });
    return { slug: candidate.slug, status: 'unsupported' };
  }

  const fetched = await fetchSpec(candidate.sourceUrl, { etag: candidate.etag, lastModified: candidate.lastModified });

  if (fetched.status === 'not_modified') {
    await markPolled(candidate.specVersionId, { pollStatus: 'not_modified' });
    return { slug: candidate.slug, status: 'not_modified' };
  }

  if (fetched.status === 'failed') {
    await markPolled(candidate.specVersionId, { pollStatus: 'failed', pollError: fetched.reason });
    return { slug: candidate.slug, status: 'failed', error: fetched.reason };
  }

  let changes: ChangeSet | null = null;
  let landedVersionId: string;
  let status: PollStatus;
  try {
    const { record, rawText } = await importSpec({ text: fetched.text, sourceUrl: candidate.sourceUrl });
    const result = await reimportApi(db, { apiId: candidate.apiId, record, rawText, source: 'poll' });
    landedVersionId = result.specVersionId;
    status = result.status;
    changes = result.changes;
  } catch (err) {
    // A spec that stopped parsing is a real finding, but it is not a new
    // version — record the failure against the version still being served.
    const reason = err instanceof Error ? err.name : 'unknown';
    await markPolled(candidate.specVersionId, { pollStatus: 'failed', pollError: reason });
    console.error('[specPoll] import failed', { slug: candidate.slug, reason });
    return { slug: candidate.slug, status: 'failed', error: reason };
  }

  // Validators belong to whichever version is now current — including the
  // unchanged and reverted cases, where no new row was written.
  await markPolled(landedVersionId, {
    pollStatus: 'ok',
    etag: fetched.etag ?? null,
    lastModified: fetched.lastModified ?? null,
  });

  return {
    slug: candidate.slug,
    status,
    ...(changes ? { counts: changes.counts, highest: changes.highest } : {}),
  };
}
