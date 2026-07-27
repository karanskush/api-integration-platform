import { auth } from '@clerk/nextjs/server';
import { after } from 'next/server';
import { loadAdvisorInsights } from '@/lib/advisor/insights';
import { AskInputError, aiReady, askAboutApi } from '@/lib/ask';
import { getOrgPlanForSlug } from '@/lib/credits';
import { dbReady, getDb } from '@/lib/db';
import { mcpCalls } from '@/lib/db/schema';
import { loadPersistentRecord } from '@/lib/persistentApi';
import { can } from '@/lib/plans';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { isOrgMember, isPrivate } from '@/lib/visibility';

export const maxDuration = 60;

// Every question is a real LLM call, so this is rate limited independently of
// (and more tightly than) the flat per-IP MCP limit.
const ASK_LIMIT = { limit: 20, windowSec: 3600 };

// A ledger weight, not a hard gate: one ask can drive several advisor-tool
// steps plus real model tokens, so it costs more than one raw MCP tool call.
// Written to the existing mcp_calls ledger (tool: 'ask') for the SAME
// analytics dashboard and Pro+ usage reporting every other MCP call already
// feeds — not a new billing dimension, just a heavier entry in the existing one.
const ASK_CREDITS = 5;

// Signed-in only, regardless of the API's own visibility (TECH_IMPLEMENTATION
// plan default) — but a PRIVATE api still requires org membership on top of
// that, same as the page/badge/MCP gates: a private API is 404 to a stranger,
// never 403, so a signed-in non-member can't tell it apart from a slug that
// doesn't exist.
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }
  if (!aiReady()) {
    return Response.json(
      { error: 'The ask assistant is not configured — set AI_GATEWAY_API_KEY and redeploy' },
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

  let body: { question?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const question = typeof body.question === 'string' ? body.question : '';

  const record = await loadPersistentRecord(slug);
  if (!record) return Response.json({ error: 'Unknown API' }, { status: 404 });

  const started = Date.now();
  try {
    const insights = await loadAdvisorInsights(slug);
    const result = await askAboutApi({ record, insights }, question);

    // Fire-and-forget, same convention as the MCP route's own analytics write:
    // never on the gating hot path, never surfaced to the caller if it fails.
    after(async () => {
      try {
        await db.insert(mcpCalls).values({
          apiId: orgPlan.apiId,
          orgId: orgPlan.orgId,
          tool: 'ask',
          status: '200',
          latencyMs: Date.now() - started,
          credits: ASK_CREDITS,
        });
      } catch {
        // best-effort analytics; never surfaced to the caller
      }
    });

    return Response.json(result);
  } catch (err) {
    if (err instanceof AskInputError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error('[ask] failed', { slug });

    after(async () => {
      try {
        await db.insert(mcpCalls).values({
          apiId: orgPlan.apiId,
          orgId: orgPlan.orgId,
          tool: 'ask',
          status: '502',
          latencyMs: Date.now() - started,
          credits: 0,
        });
      } catch {
        // best-effort analytics; never surfaced to the caller
      }
    });

    return Response.json({ error: 'The assistant could not answer that question right now.' }, { status: 502 });
  }
}
