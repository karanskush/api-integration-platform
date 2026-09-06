// Shared MCP tool-building/arg-validation/upstream-call logic — used by both
// the ephemeral /mcp/[id] handler (Redis-backed) and the persistent
// /mcp/[slug] handler (Postgres-backed), so the two don't duplicate this
// ~80-line core.

import { isAdvisorTool } from './advisor';
import { pickCapturedHeaders } from './changes/lifecycle';
import type { Action, AuthPlacement } from './ir';
import { safeFetch, SsrfError, UpstreamError } from './ssrf';
import { buildUpstreamRequest, UpstreamBuildError } from './upstream';
import { validateParams } from './validate';

// A third-party spec can declare an operationId that collides with an advisor
// tool's `docentapi_`-prefixed name. The advisor tool wins — it is part of this
// server's fixed contract — so the colliding endpoint tool is suffixed to stay
// reachable rather than silently shadowed.
//
// Applied to the FULL action list, not the MCP-exposed subset: advisor tools
// (get_endpoint_schema, describe_fields, trace_field, get_call_sequence)
// deliberately still describe a destructive action even though it is hidden
// from execution — flagged `exposedOverMcp: false` rather than omitted — so a
// colliding destructive action needs its resolved name too, or it would be
// invisible to advisor tools as well as uncallable, instead of merely the
// latter. Callers therefore resolve collisions once, over every action, before
// filtering to the exposed subset.
export function resolveNameCollisions(actions: Action[]): Action[] {
  return actions.map((a) => (isAdvisorTool(a.name) ? { ...a, name: `${a.name}_api` } : a));
}

// ToolDescriptor and buildToolList live in toolList.ts (a leaf module) and are
// re-exported here so existing importers keep working.
export { buildToolList } from './toolList';
export type { ToolDescriptor } from './toolList';

export type ToolCallOutcome = {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
  status?: number;
  latencyMs?: number;
};

export function toolText(text: string, isError = false): ToolCallOutcome {
  return { content: [{ type: 'text', text }], isError };
}

export type ToolCallTarget = { baseUrls: string[]; authIn?: AuthPlacement };

export class NoBaseUrlError extends Error {
  constructor() {
    super('This API declared no public base URL — calls are disabled.');
    this.name = 'NoBaseUrlError';
  }
}

export class InvalidArgsError extends Error {
  constructor(detail: string) {
    super(`Invalid arguments: ${detail}`);
    this.name = 'InvalidArgsError';
  }
}

export class AuthRequiredError extends Error {
  constructor(auth: string) {
    super(
      `This API requires ${auth} auth. Supply your key via the x-docentapi-upstream-key header (or ?key= in the server URL). DocentAPI never stores it.`,
    );
    this.name = 'AuthRequiredError';
  }
}

export type InvokeActionOptions = {
  // callActionTool (the only other caller) always wants this true — the MCP
  // surface should never forward an unauthenticated request the caller
  // didn't ask for. The probe engine's auth-clarity check deliberately sets
  // this false: it *wants* to send an unauthenticated request, to observe
  // whether the live API actually rejects it rather than just trusting the
  // spec's documented auth scheme.
  requireAuth?: boolean;
};

// Pure validate → auth-check → upstream-call → decode-body core, shared by
// callActionTool (MCP surface) and the Phase 2 probe engine. Lets
// UpstreamBuildError/SsrfError/UpstreamError propagate as thrown errors —
// callers decide how to present them (callActionTool wraps them in
// toolText(), probes catch/inspect them directly).
export type InvokeResult = {
  status: number;
  latencyMs: number;
  bodyText: string;
  // Allowlisted response headers (changes/lifecycle.ts) — Deprecation, Sunset,
  // Link, and the vendor equivalents. Optional so the many test doubles that
  // return a bare {status, latencyMs, bodyText} stay valid; probes treat an
  // absent map as "no signals".
  headers?: Record<string, string>;
};

export async function invokeAction(
  action: Action,
  args: Record<string, unknown>,
  target: ToolCallTarget,
  upstreamKey: string | undefined,
  opts: InvokeActionOptions = {},
): Promise<InvokeResult> {
  const baseUrl = target.baseUrls[0];
  if (!baseUrl) throw new NoBaseUrlError();

  const invalid = validateParams(action, args);
  if (invalid) throw new InvalidArgsError(invalid);

  const requireAuth = opts.requireAuth ?? true;
  if (requireAuth && action.auth !== 'none' && !upstreamKey) throw new AuthRequiredError(action.auth);

  const upstream = buildUpstreamRequest(action, args, { token: upstreamKey }, baseUrl, target.authIn);
  const res = await safeFetch(upstream.url, {
    method: upstream.method,
    headers: upstream.headers,
    body: upstream.body,
    timeoutMs: 30_000,
    maxBytes: 1024 * 1024,
  });
  const bodyText = new TextDecoder().decode(res.body);
  // Lifecycle headers ride along on every call the platform already makes —
  // the cheapest change signal available, and until now discarded.
  return { status: res.status, latencyMs: res.latencyMs, bodyText, headers: pickCapturedHeaders(res.headers) };
}

// Throws only on truly unexpected errors — callers should catch, log with
// their own context (server id, tool name), and return a generic toolText().
export async function callActionTool(
  action: Action,
  args: Record<string, unknown>,
  target: ToolCallTarget,
  upstreamKey: string | undefined,
): Promise<ToolCallOutcome> {
  try {
    const { status, latencyMs, bodyText } = await invokeAction(action, args, target, upstreamKey);
    const summary = `HTTP ${status} · ${latencyMs}ms\n${bodyText || '(empty body)'}`;
    return { ...toolText(summary, status >= 400), status, latencyMs };
  } catch (err) {
    if (err instanceof NoBaseUrlError) return toolText(err.message, true);
    if (err instanceof InvalidArgsError) return toolText(err.message, true);
    if (err instanceof AuthRequiredError) return toolText(err.message, true);
    if (err instanceof UpstreamBuildError) return toolText(err.message, true);
    if (err instanceof SsrfError) return toolText('Upstream URL blocked by safety policy.', true);
    if (err instanceof UpstreamError) return toolText(err.message, true);
    throw err;
  }
}
