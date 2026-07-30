import { auth } from '@clerk/nextjs/server';
import { after } from 'next/server';
import { loadAdvisorInsights } from '@/lib/advisor/insights';
import { AskInputError, askConfigProblem, streamAskAboutApi, type AskOutcome } from '@/lib/ask';
import { ASK_OUTCOME_UNSETTLED, askCallerHash, askLedgerRow } from '@/lib/askLedger';
import { logModelFailure } from '@/lib/askLog';
import { messagesFromQuestion, sanitizeAskMessages } from '@/lib/askMessages';
import { getOrgPlanForSlug } from '@/lib/credits';
import { dbReady, getDb } from '@/lib/db';
import { mcpCalls } from '@/lib/db/schema';
import { loadPersistentRecord } from '@/lib/persistentApi';
import { can } from '@/lib/plans';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { isOrgMember, isPrivate } from '@/lib/visibility';

// Streaming does NOT relax this: the invocation lives until the body closes AND
// every after() callback settles, so this still has to cover target resolution,
// the record and insight loads, up to MAX_STEPS model round trips with tool
// execution between them, the final drain, and the ledger write. What streaming
// improves is perceived latency, not the ceiling. streamText carries its own
// shorter budget so the model fails visibly before the platform kills the
// function — a platform kill records nothing at all.
export const maxDuration = 60;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Every turn is a real LLM call, so this is rate limited independently of (and
// more tightly than) the flat per-IP MCP limit.
//
// Raised from 20 because multi-turn changed what one unit means: 20 used to be
// 20 questions, and is now roughly two exploratory threads. 60 is ~6-10 threads
// an hour while still hard-capping a scripted abuser at 60 generations.
const ASK_LIMIT = { limit: envInt('ASK_TURNS_PER_HOUR', 60), windowSec: 3600 };
const ASK_API_LIMIT = { limit: envInt('ASK_TURNS_PER_HOUR_PER_API', 30), windowSec: 3600 };

// How long after() waits for the stream to report how it ended before recording
// the turn as a hang. Comfortably past streamText's own 90s total budget.
const LEDGER_WAIT_MS = 100_000;

// Signed-in only, regardless of the API's own visibility (TECH_IMPLEMENTATION
// plan default) — but a PRIVATE api still requires org membership on top of
// that, same as the page/badge/MCP gates: a private API is 404 to a stranger,
// never 403, so a signed-in non-member can't tell it apart from a slug that
// doesn't exist.
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }
  // Names the actual missing variable rather than always blaming
  // AI_GATEWAY_API_KEY, which was wrong for every Azure-configured deploy. Logged
  // as well as returned, so an operator sees the reason even though this response
  // only ever reaches someone who cannot fix it.
  const configProblem = askConfigProblem();
  if (configProblem) {
    console.error('[ask] not configured', { reason: configProblem.reason });
    return Response.json(
      { error: `The ask assistant is not configured — ${configProblem.hint}` },
      { status: 503 },
    );
  }

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const rl = await getLimiter('ask', ASK_LIMIT).limit(userId);
  if (!rl.success) return tooMany(rl.reset);

  const { slug } = await ctx.params;
  const db = getDb();

  const orgPlan = await getOrgPlanForSlug(db, slug);
  if (!orgPlan) return Response.json({ error: 'Unknown API' }, { status: 404 });

  if (isPrivate(orgPlan.visibility) && !(await isOrgMember(userId, orgPlan.orgId))) {
    return Response.json({ error: 'Unknown API' }, { status: 404 });
  }

  if (!can(orgPlan.plan, 'askAssistant')) {
    return Response.json(
      { error: 'Ask is a Pro plan feature — upgrade to ask natural-language questions about this API.' },
      { status: 403 },
    );
  }

  // Bounds one visitor against ONE provider's Stripe meter, which the global
  // limiter above cannot: mcp_calls.org_id is the API OWNER's org (see the note
  // on the ledger below), so without this a single caller can run up a bill
  // against a provider they have no relationship with. Checked after the 404/403
  // gates so the limiter key can never be used to probe which slugs exist.
  const perApi = await getLimiter('ask-api', ASK_API_LIMIT).limit(`${userId}:${slug}`);
  if (!perApi.success) return tooMany(perApi.reset);

  let body: { question?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const record = await loadPersistentRecord(slug);
  if (!record) return Response.json({ error: 'Unknown API' }, { status: 404 });

  const started = Date.now();

  // Must precede sanitization: sanitizeAskMessages re-executes advisor tools to
  // re-derive every replayed tool result, and needs the full AdvisorContext.
  const insights = await loadAdvisorInsights(slug);

  let messages;
  try {
    // Back-compat for one release, so the shipped single-shot UI keeps working
    // while the streaming client lands. Remove once AskChannel is deployed.
    const raw = body.messages ?? messagesFromQuestion(body.question);
    messages = sanitizeAskMessages(raw, { record, insights });
  } catch (err) {
    if (err instanceof AskInputError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }

  // The ledger, under streaming.
  //
  // after() is registered ONCE, synchronously, before the Response is returned.
  // It cannot be called from inside a stream callback — that runs while the body
  // is being consumed, which is not a documented-safe context — and the insert
  // cannot live in onEnd either: awaited it would block the final chunk,
  // un-awaited it would race the function freeze. So the callbacks only resolve
  // a promise, and after() (which keeps the invocation alive until it settles)
  // does the write.
  let settle!: (outcome: AskOutcome | typeof ASK_OUTCOME_UNSETTLED) => void;
  const outcome = new Promise<AskOutcome | typeof ASK_OUTCOME_UNSETTLED>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const settleOnce = (value: AskOutcome) => {
    if (settled) return;
    settled = true;
    settle(value);
  };

  const response = await streamAskAboutApi(
    { record, insights },
    messages,
    // req.signal + onAbort records the turn and stops the spend. Deliberately NOT
    // result.consumeStream(): forcing the stream to drain after the reader has
    // gone keeps generating tokens for nobody.
    { abortSignal: req.signal, onOutcome: settleOnce },
  );

  after(async () => {
    const settledOutcome = await Promise.race([
      outcome,
      new Promise<typeof ASK_OUTCOME_UNSETTLED>((resolve) =>
        setTimeout(() => resolve(ASK_OUTCOME_UNSETTLED), LEDGER_WAIT_MS),
      ),
    ]);
    if (settledOutcome.status === 'error') {
      logModelFailure('[ask]', { slug }, settledOutcome.error);
    }
    try {
      await db.insert(mcpCalls).values(
        askLedgerRow(settledOutcome, {
          apiId: orgPlan.apiId,
          orgId: orgPlan.orgId,
          startedAt: started,
          callerHash: askCallerHash(userId),
        }),
      );
    } catch {
      // best-effort analytics; never surfaced to the caller
    }
  });

  return response;
}
