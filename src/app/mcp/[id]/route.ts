import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createMcpHandler } from 'mcp-handler';
import { after } from 'next/server';
import { creditLimiter, getOrgPlanForSlug } from '@/lib/credits';
import { dbReady, getDb } from '@/lib/db';
import { mcpCalls } from '@/lib/db/schema';
import { isValidId } from '@/lib/ids';
import { clientIp } from '@/lib/ip';
import { mcpExposedActions } from '@/lib/ir';
import { kv } from '@/lib/kv';
import { buildToolList, callActionTool, toolText } from '@/lib/mcpTools';
import { loadPersistentRecord } from '@/lib/persistentApi';
import { limitsFor } from '@/lib/plans';
import { getLimiter, tooMany } from '@/lib/ratelimit';

export const maxDuration = 60;

// Multi-tenant MCP server (Streamable HTTP, stateless): the handler is
// constructed per request with the tools resolved from the stored import.
// Tool schemas are the stored JSON Schema verbatim — no zod round-trip —
// and tools/call args are validated with the same Ajv the proxy uses.
//
// Single route for BOTH ephemeral (Redis) and persistent (Postgres) APIs —
// Next.js doesn't allow two differently-named dynamic segments at the same
// path depth (`/mcp/[id]` and `/mcp/[slug]` both match `/mcp/*` and are
// rejected as ambiguous at build time), so this dispatches on lookup instead
// of on route. MCP auth stays bearer/API-key BYOK only for Phase 1, per
// ARCHITECTURE_2026-05-20.md's decision to add OAuth 2.1 later. Persistent
// (org-backed) APIs additionally get an org-scoped daily credit ceiling on
// top of the flat per-IP rate limit below; ephemeral APIs keep only the flat
// limit — there's no org/plan to meter against.

function jsonRpcError(status: number, message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32001, message }, id: null },
    { status },
  );
}

function appOrigin(req: Request): string {
  return process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || new URL(req.url).origin;
}

async function handler(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const rl = await getLimiter('mcp', { limit: 60, windowSec: 60 }).limit(clientIp(req));
  if (!rl.success) return tooMany(rl.reset);

  // An id-shaped slug is possible (rare) if a persistent api's slug happens
  // to be 10 plain alnum chars — an id-shaped Redis miss still falls back
  // to Postgres.
  const ephemeralRecord = isValidId(id) ? await kv().getImport(id) : null;
  const record = ephemeralRecord ?? (await loadPersistentRecord(id));
  if (!record || record.expiresAt <= Date.now()) {
    return jsonRpcError(404, 'Unknown or expired Spotcheck id — re-import the spec to mint a new server');
  }
  const orgPlan = !ephemeralRecord && dbReady() ? await getOrgPlanForSlug(getDb(), id) : null;

  // BYOK: upstream credential rides a documented header (preferred) or ?key=
  const upstreamKey =
    req.headers.get('x-spotcheck-upstream-key') ??
    new URL(req.url).searchParams.get('key') ??
    undefined;

  const exposed = mcpExposedActions(record);

  const mcp = createMcpHandler(
    (server) => {
      const low = server.server;
      low.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: buildToolList(exposed),
      }));

      low.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const action = exposed.find((a) => a.name === params.name);
        if (!action) return toolText(`Unknown tool: ${params.name}`, true);

        if (orgPlan) {
          const ceiling = limitsFor(orgPlan.plan).mcpCallsPerDay;
          const credit = await creditLimiter(ceiling).limit(orgPlan.orgId);
          if (!credit.success) {
            return toolText(
              `Daily MCP call limit reached for this plan. Upgrade at ${appOrigin(req)}/pricing for more credits.`,
              true,
            );
          }
        }

        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const outcome = await callActionTool(
            action,
            args,
            { baseUrls: record.baseUrls, authIn: record.authIn },
            upstreamKey,
          );
          if (outcome.status !== undefined) {
            console.log('[mcp]', { id, tool: action.name, status: outcome.status, latencyMs: outcome.latencyMs });
            // Durable analytics ledger — fire-and-forget, never on the
            // gating hot path (that only ever touches Redis above).
            if (orgPlan) {
              const { apiId, orgId } = orgPlan;
              const status = outcome.status;
              const latencyMs = outcome.latencyMs ?? 0;
              after(async () => {
                try {
                  await getDb().insert(mcpCalls).values({ apiId, orgId, tool: action.name, status: String(status), latencyMs });
                } catch {
                  // best-effort analytics; never surfaced to the caller
                }
              });
            }
          }
          return { content: outcome.content, isError: outcome.isError };
        } catch {
          console.error('[mcp] unexpected', { id, tool: action.name });
          return toolText('Tool call failed unexpectedly.', true);
        }
      });
    },
    {
      serverInfo: { name: `spotcheck-${record.id}`, version: '0.1.0' },
      capabilities: { tools: {} },
      instructions: `Tools for the "${record.name}" API, generated by Spotcheck. ${
        record.auth !== 'none'
          ? 'Requests need the caller-supplied upstream API key (BYOK) — it is passed through, never stored.'
          : ''
      }`,
    },
    {
      streamableHttpEndpoint: `/mcp/${id}`,
      disableSse: true,
      maxDuration: 55,
      verboseLogs: false,
    },
  );

  return mcp(req);
}

export { handler as GET, handler as POST, handler as DELETE };
