import { emptyInsights } from '@/lib/advisor';
import { AskInputError, aiReady, askAboutApi } from '@/lib/ask';
import { isValidId } from '@/lib/ids';
import { ttlSeconds } from '@/lib/ir';
import { clientIp } from '@/lib/ip';
import { kv, storageReady } from '@/lib/kv';
import { getLimiter, tooMany } from '@/lib/ratelimit';

export const maxDuration = 60;

// Anonymous asking on the instant-preview page (/p/[id]) — no account, no
// plan, matching the "paste a spec, ask it questions" pitch the claimed/
// Pro+ path (api/apis/[slug]/ask) can't offer someone who hasn't signed up.
// Bounded on two independent axes to cap the real LLM cost an anonymous
// caller can run up: a hard per-paste quota (this specific import, capped
// over its own remaining TTL so the counter dies alongside the paste) and a
// broader per-IP ceiling (stop someone re-pasting the same spec repeatedly
// just to bypass the first cap).
const IP_ASK_LIMIT = { limit: 20, windowSec: 3600 };
const PASTE_ASK_LIMIT = 5;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!storageReady()) {
    return Response.json({ error: 'Storage not configured — connect Upstash Redis and redeploy' }, { status: 503 });
  }
  if (!aiReady()) {
    return Response.json(
      { error: 'The ask assistant is not configured — set AI_GATEWAY_API_KEY and redeploy' },
      { status: 503 },
    );
  }

  const { id } = await ctx.params;
  if (!isValidId(id)) return Response.json({ error: 'Unknown or expired import' }, { status: 404 });

  const record = await kv().getImport(id);
  if (!record || record.expiresAt <= Date.now()) {
    return Response.json({ error: 'This import has expired — re-import the spec first' }, { status: 404 });
  }

  const ipLimit = await getLimiter('anon-ask-ip', IP_ASK_LIMIT).limit(clientIp(req));
  if (!ipLimit.success) return tooMany(ipLimit.reset);

  const pasteLimit = await getLimiter('anon-ask-paste', { limit: PASTE_ASK_LIMIT, windowSec: ttlSeconds() }).limit(id);
  if (!pasteLimit.success) {
    return Response.json(
      { error: 'Free question limit reached for this paste — sign in and claim this API to keep asking.' },
      { status: 429 },
    );
  }

  let body: { question?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const question = typeof body.question === 'string' ? body.question : '';

  try {
    const result = await askAboutApi({ record, insights: emptyInsights() }, question);
    return Response.json(result);
  } catch (err) {
    if (err instanceof AskInputError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error('[ask] anonymous ask failed', { id });
    return Response.json({ error: 'The assistant could not answer that question right now.' }, { status: 502 });
  }
}
