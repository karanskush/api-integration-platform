import { emptyInsights } from '@/lib/advisor';
import { AskInputError, askConfigProblem, streamAskAboutApi } from '@/lib/ask';
import { logModelFailure } from '@/lib/askLog';
import { messagesFromQuestion, sanitizeAskMessages } from '@/lib/askMessages';
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
//
// Both raised because multi-turn changed what one unit buys: 5 turns is a single
// truncated thread, too tight to demonstrate the feature to someone deciding
// whether to sign up. 12 is two or three short threads. The per-IP ceiling stays
// at roughly 2x the paste cap so the "re-paste to reset" bypass is still bounded.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const IP_ASK_LIMIT = { limit: envInt('ASK_TURNS_PER_HOUR_ANON_IP', 40), windowSec: 3600 };
const PASTE_ASK_LIMIT = envInt('ASK_TURNS_PER_PASTE', 12);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!storageReady()) {
    return Response.json({ error: 'Storage not configured — connect Upstash Redis and redeploy' }, { status: 503 });
  }
  // Names the actual missing variable rather than always blaming
  // AI_GATEWAY_API_KEY, which was wrong for every Azure-configured deploy. Logged
  // as well as returned: a visitor cannot act on this, an operator can.
  const configProblem = askConfigProblem();
  if (configProblem) {
    console.error('[ask] anonymous ask not configured', { reason: configProblem.reason });
    return Response.json(
      { error: `The ask assistant is not configured — ${configProblem.hint}` },
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

  let body: { question?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const advisorCtx = { record, insights: emptyInsights() };
  let messages;
  try {
    // Back-compat for one release; see the note in the authenticated route.
    messages = sanitizeAskMessages(body.messages ?? messagesFromQuestion(body.question), advisorCtx);
  } catch (err) {
    if (err instanceof AskInputError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }

  // No ledger here: an anonymous paste has no org to attribute a credit to, and
  // both quotas above were already consumed before the stream opened. The only
  // thing left to do on failure is say so in the log — which a 502 used to do
  // and an in-stream error part no longer can.
  return streamAskAboutApi(advisorCtx, messages, {
    abortSignal: req.signal,
    onOutcome: (outcome) => {
      if (outcome.status === 'error') logModelFailure('[ask] anonymous', { id }, outcome.error);
    },
  });
}
