// search_endpoints + get_endpoint_schema.
//
// The point of these two is context economy: an agent facing a 300-action API
// should not have to pull every tool schema into its window to find the one
// operation it needs. Search returns one compact line per hit; the schema tool
// then returns full detail for exactly one action.

import { fieldMapFor } from '../fieldMap';
import type { Action, ImportRecord } from '../ir';
import { paginationFor } from '../pagination';
import { actionSummary, asData, paramsOf, type AdvisorContext } from './types';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const FIELD_SUMMARY_LIMIT = 40;
// Roughly the point past which a raw schema stops being readable and starts
// being a context tax. Callers wanting more use describe_fields, which paginates
// and filters.
const MAX_RAW_SCHEMA_CHARS = 6000;

// Raw schemas were previously returned verbatim and unbounded. A single Stripe
// body can run to tens of kilobytes, which is a real cost when the caller is an
// LLM paying for every token of it.
function capSchema(schema: unknown, label: string): unknown {
  if (schema === null || schema === undefined) return null;
  const serialized = JSON.stringify(schema);
  if (serialized.length <= MAX_RAW_SCHEMA_CHARS) return schema;

  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  return {
    omitted: true,
    reason: `This ${label} schema is ${serialized.length} characters — too large to return inline.`,
    topLevelKeys: properties ? Object.keys(properties).slice(0, 60) : undefined,
    use: 'spotcheck_describe_fields with a filter argument to inspect it field by field.',
  };
}

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
  const map = fieldMapFor(action);
  const sendable = map.request.filter((f) => !f.readOnly && !f.container);
  const serverAssigned = map.request.filter((f) => f.readOnly).map((f) => f.path);
  const pagination = paginationFor(action, map);

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
    // Flattened, addressable view of everything sendable — the part an agent
    // can act on without parsing a nested schema itself. Bounded; the full
    // picture lives behind describe_fields.
    fields: {
      sendable: sendable.slice(0, FIELD_SUMMARY_LIMIT).map((f) => ({
        path: f.path,
        type: f.nullable ? `${f.type}|null` : f.type,
        required: f.required,
        ...(f.format ? { format: f.format } : {}),
        ...(f.enum ? { allowed: f.enum } : {}),
      })),
      totalSendable: sendable.length,
      ...(serverAssigned.length ? { serverAssigned: serverAssigned.slice(0, 20) } : {}),
      ...(sendable.length > FIELD_SUMMARY_LIMIT || map.truncated
        ? { note: `Showing ${Math.min(sendable.length, FIELD_SUMMARY_LIMIT)} of ${sendable.length}. Call spotcheck_describe_fields for the rest, with a filter.` }
        : {}),
    },
    ...(pagination.model !== 'none' ? { pagination } : {}),
    // Raw schemas, capped. These were echoed verbatim with no size limit, so a
    // deeply nested body could swamp the caller's context on its own (LLM10).
    requestBodySchema: capSchema(
      params.some((p) => p.in === 'body')
        ? ((action.paramsSchema.properties as Record<string, unknown> | undefined)?.body ?? null)
        : null,
      'request body',
    ),
    responseSchema: capSchema(action.responseSchema ?? null, 'response'),
    errorSchema: capSchema(action.errorSchema ?? null, 'error'),
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
