import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import {
  CI_ERROR_MESSAGE,
  CI_ERROR_STATUS,
  CI_SIGNATURE_HEADER,
  CI_TIMESTAMP_HEADER,
  ciReplayKey,
  verifyCiRequest,
} from '@/lib/ciSync';
import { dbReady, getDb } from '@/lib/db';
import { apis } from '@/lib/db/schema';
import { runImport, ImportInputError } from '@/lib/importer';
import { CurlParseError } from '@/lib/importer/curl';
import { DetectError } from '@/lib/importer/detect';
import { ParseError } from '@/lib/importer/openapi';
import { PostmanConvertError } from '@/lib/importer/postman';
import { masterKeyReady } from '@/lib/keys';
import { reimportApi } from '@/lib/persist';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { markSeen } from '@/lib/replay';
import { scorePreview } from '@/lib/scorePreview';
import { SsrfError, UpstreamError } from '@/lib/ssrf';

export const maxDuration = 60;

const MAX_TEXT_BYTES = 1024 * 1024;
const SYNC_LIMIT = { limit: 60, windowSec: 3600 };

// Spec sync from CI (TECH_IMPLEMENTATION.md §3.10). On every push that touches
// the spec, the GitHub Action posts a signed payload here and this re-imports,
// re-normalizes, re-scores the preview, and purges the page and badge — so a
// drifting spec can never ship silently.
//
// Auth is HMAC over `${timestamp}.${rawBody}` with a per-API derived token; see
// ciSync.ts for why the token is never stored. Note the body is read as TEXT
// first and only then parsed: the signature has to cover the exact bytes sent,
// and re-serializing parsed JSON would not reproduce them.
export async function POST(req: Request) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }
  if (!masterKeyReady()) {
    return Response.json({ error: 'CI sync is not configured — set DOCENTAPI_MASTER_KEY and redeploy' }, { status: 503 });
  }

  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_TEXT_BYTES) {
    return Response.json({ error: 'Payload too large (max 1MB)' }, { status: 413 });
  }

  let body: { slug?: unknown; specUrl?: unknown; specText?: unknown; failBelow?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  if (!slug) return Response.json({ error: 'slug is required' }, { status: 400 });

  // Rate limit keyed on the claimed slug, before any crypto or DB write. An
  // unauthenticated caller can still burn this budget for a slug they don't
  // own, which is the accepted cost of not leaking whether a slug exists.
  const rl = await getLimiter('ci-sync', SYNC_LIMIT).limit(slug);
  if (!rl.success) return tooMany(rl.reset);

  const db = getDb();
  const [api] = await db
    .select({ id: apis.id, slug: apis.slug, claimStatus: apis.claimStatus, ciTokenVersion: apis.ciTokenVersion })
    .from(apis)
    .where(eq(apis.slug, slug))
    .limit(1);

  // Same 401 for "no such slug" and "bad signature": an unauthenticated caller
  // must not be able to enumerate which pages exist.
  const unauthorized = () => Response.json({ error: CI_ERROR_MESSAGE.bad_signature }, { status: 401 });
  if (!api || api.claimStatus !== 'claimed') return unauthorized();

  const signature = req.headers.get(CI_SIGNATURE_HEADER);
  const verdict = verifyCiRequest({
    apiId: api.id,
    tokenVersion: api.ciTokenVersion,
    timestampHeader: req.headers.get(CI_TIMESTAMP_HEADER),
    signatureHeader: signature,
    rawBody,
  });
  if (!verdict.ok) {
    return Response.json(
      { error: CI_ERROR_MESSAGE[verdict.reason] },
      { status: CI_ERROR_STATUS[verdict.reason] },
    );
  }

  // Freshness bounds replay to the skew window; this closes it inside the
  // window too. Best-effort: without Redis a replay is still bounded by the
  // window, which is the same guarantee GitHub's own webhooks give.
  const fresh = await markSeen(ciReplayKey(api.id, signature!));
  if (!fresh) {
    return Response.json({ error: 'This request has already been processed' }, { status: 409 });
  }

  const specUrl = typeof body.specUrl === 'string' ? body.specUrl.trim() : undefined;
  const specText = typeof body.specText === 'string' ? body.specText : undefined;
  if (!specUrl && !specText) {
    return Response.json({ error: 'Provide specUrl or specText' }, { status: 400 });
  }
  if (specText && Buffer.byteLength(specText, 'utf8') > MAX_TEXT_BYTES) {
    return Response.json({ error: 'Spec is too large (max 1MB)' }, { status: 413 });
  }

  const failBelow =
    typeof body.failBelow === 'number' && Number.isFinite(body.failBelow)
      ? Math.max(0, Math.min(100, Math.floor(body.failBelow)))
      : null;

  try {
    const { record, rawText } = await runImport({ url: specUrl, text: specText });
    const result = await reimportApi(db, { apiId: api.id, record, rawText });

    if (result.status !== 'unchanged') {
      // Purge the ISR page and the badge so a README badge cannot keep
      // advertising a score computed against a spec that no longer exists.
      revalidatePath(`/${api.slug}`);
      revalidatePath(`/badge/${api.slug}`);
    }

    const preview = scorePreview(record);
    const gate = failBelow === null ? null : { failBelow, passed: preview.total >= failBelow };

    const payload = {
      ok: gate ? gate.passed : true,
      slug: api.slug,
      status: result.status,
      specVersionId: result.specVersionId,
      contentHash: result.contentHash,
      actionCount: record.actions.length,
      counts: record.counts,
      scorePreview: {
        total: preview.total,
        verified: false,
        checks: preview.checks.map((c) => ({ id: c.id, points: c.points, maxPoints: c.maxPoints, message: c.message })),
      },
      ...(gate ? { gate } : {}),
      note:
        result.status === 'unchanged'
          ? 'Spec content is byte-identical to the current version — nothing was rewritten.'
          : result.status === 'reverted'
            ? 'Spec content matches an earlier version of this API; the page now points back at it.'
            : 'A new spec version was recorded and the page and badge were purged.',
    };

    // A failed score gate is a build signal, not a server error — 422 so the
    // Action step fails while the body stays readable.
    return Response.json(payload, { status: gate && !gate.passed ? 422 : 200 });
  } catch (err) {
    if (err instanceof SsrfError) {
      return Response.json({ error: `Spec URL not allowed: ${err.message}` }, { status: 400 });
    }
    if (err instanceof UpstreamError) {
      return Response.json({ error: err.message }, { status: 502 });
    }
    if (
      err instanceof ImportInputError ||
      err instanceof DetectError ||
      err instanceof CurlParseError ||
      err instanceof PostmanConvertError ||
      err instanceof ParseError
    ) {
      // A spec that no longer parses is exactly what CI should catch, so this
      // is a hard failure with the parser's own message.
      return Response.json(
        { ok: false, error: err.message, stage: 'parse' },
        { status: err instanceof ImportInputError ? 400 : 422 },
      );
    }
    console.error('[ci/sync] unexpected', { slug: api.slug });
    return Response.json({ error: 'Sync failed unexpectedly' }, { status: 500 });
  }
}
