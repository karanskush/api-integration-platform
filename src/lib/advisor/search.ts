// search_endpoints + get_endpoint_schema.
//
// The point of these two is context economy: an agent facing a 300-action API
// should not have to pull every tool schema into its window to find the one
// operation it needs. Search returns one compact line per hit; the schema tool
// then returns full detail for exactly one action.

import type { Action, ImportRecord } from '../ir';
import { actionSummary, asData, paramsOf, type AdvisorContext } from './types';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

// Weighted overlap across the fields that actually identify an operation.
// Name and path are authoritative; descriptions are noisy third-party prose,
// so they contribute least.
function scoreAction(action: Action, tokens: string[], rawQuery: string): number {
  const name = action.name.toLowerCase();
  const path = action.path.toLowerCase();
  const description = action.description.toLowerCase();
  const method = action.method.toLowerCase();
  const pathTokens = new Set(tokenize(path));
  const nameTokens = new Set(tokenize(name));

  let score = 0;
  if (name === rawQuery.trim().toLowerCase()) score += 100; // exact tool name
  if (path === rawQuery.trim().toLowerCase()) score += 80;

  for (const token of tokens) {
    if (METHODS.has(token)) {
      if (method === token) score += 6;
      continue;
    }
    if (nameTokens.has(token)) score += 12;
    else if (name.includes(token)) score += 7;
    if (pathTokens.has(token)) score += 9;
    else if (path.includes(token)) score += 4;
    if (description.includes(token)) score += 2;
  }
  return score;
}

export type SearchArgs = {
  query?: unknown;
  limit?: unknown;
  safety?: unknown;
};

export function searchEndpoints(ctx: AdvisorContext, args: SearchArgs) {
  const query = typeof args.query === 'string' ? args.query : '';
  const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, requested));
  const safetyFilter =
    args.safety === 'read' || args.safety === 'write' || args.safety === 'destructive' ? args.safety : null;

  let candidates = ctx.record.actions;
  if (safetyFilter) candidates = candidates.filter((a) => a.safety === safetyFilter);

  const tokens = tokenize(query);

  // No query is a legitimate "show me around" call — return a stable
  // alphabetical page rather than an arbitrary relevance order.
  const ranked = !tokens.length
    ? [...candidates].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    : candidates
        .map((action) => ({ action, score: scoreAction(action, tokens, query) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.action.path.length - b.action.path.length)
        .map((r) => r.action);

  return {
    query: asData(query, 200),
    matched: ranked.length,
    returned: Math.min(limit, ranked.length),
    totalActions: ctx.record.actions.length,
    results: ranked.slice(0, limit).map(actionSummary),
    ...(ranked.length === 0
      ? {
          hint: 'No operation matched. Call with no query to list every operation, or try a resource noun from the API (e.g. "customer", "invoice").',
        }
      : {}),
  };
}

function describeIdempotency(action: Action, ctx: AdvisorContext) {
  const observed = ctx.insights.idempotencyObservations.find((o) => o.actionId === action.id);
  if (observed) {
    return observed.hasIdempotencySignal
      ? { retrySafe: 'requires_key' as const, idempotencyParam: observed.matchedParam, source: 'observed' as const }
      : { retrySafe: 'unsafe' as const, source: 'observed' as const };
  }
  if (action.method === 'GET' || action.method === 'HEAD') {
    return { retrySafe: 'safe' as const, source: 'method_semantics' as const };
  }
  if (action.method === 'PUT' || action.method === 'DELETE') {
    return { retrySafe: 'safe' as const, source: 'method_semantics' as const };
  }
  return { retrySafe: 'unknown' as const, source: 'not_probed' as const };
}

export type EndpointSchemaArgs = { tool?: unknown };

export function getEndpointSchema(ctx: AdvisorContext, args: EndpointSchemaArgs) {
  const wanted = typeof args.tool === 'string' ? args.tool.trim() : '';
  if (!wanted) return { error: 'tool is required — pass the tool name returned by search_endpoints.' };

  const action = ctx.record.actions.find((a) => a.name === wanted);
  if (!action) {
    const close = ctx.record.actions
      .filter((a) => a.name.includes(wanted) || wanted.includes(a.name))
      .slice(0, 5)
      .map((a) => a.name);
    return {
      error: `No operation named "${asData(wanted, 80)}" exists on this API.`,
      ...(close.length ? { didYouMean: close } : {}),
    };
  }

  const params = paramsOf(action);
  const drift = ctx.insights.driftObservations.find((o) => o.actionId === action.id);

  return {
    tool: action.name,
    method: action.method,
    path: action.path,
    baseUrls: ctx.record.baseUrls,
    safety: action.safety,
    exposedOverMcp: action.safety !== 'destructive',
    description: asData(action.description),
    auth: {
      scheme: action.auth,
      ...(action.authIn ?? ctx.record.authIn ? { placement: action.authIn ?? ctx.record.authIn } : {}),
      satisfiableWithApiKey: action.auth !== 'oauth2',
    },
    parameters: params,
    requestBodySchema: params.some((p) => p.in === 'body')
      ? ((action.paramsSchema.properties as Record<string, unknown> | undefined)?.body ?? null)
      : null,
    responseSchema: action.responseSchema ?? null,
    errorSchema: action.errorSchema ?? null,
    examples: action.examples.slice(0, 3),
    retry: describeIdempotency(action, ctx),
    ...(drift
      ? {
          observedDrift: {
            matchedFields: drift.matchedFields,
            declaredFields: drift.declaredFields,
            mismatches: drift.mismatches.slice(0, 20),
            note: 'Fields listed in mismatches were documented but absent (or differently typed) in a real response.',
          },
        }
      : {}),
    ...(action.responseSchema
      ? {}
      : { note: 'This operation documents no response schema, so the shape of a successful response is unverified.' }),
  };
}
