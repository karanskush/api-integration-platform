// The one way a probe talks to the network.
//
// Every probe used to build its own `target`, pick its own timeout and — in four
// of seven — send the playground's User-Agent, so a provider reading their
// access log could not tell verification traffic from a person clicking around.
// This module owns those decisions so they are made once:
//
//   * the target honours a per-environment base URL override (a declared
//     sandbox host) instead of always taking `baseUrls[0]`;
//   * every call carries the contactable probe User-Agent and the short step
//     timeout — six sequential 30 s calls would blow the route's 60 s ceiling;
//   * any ValueRef in the params is unwrapped here, immediately before the
//     request, which keeps transient.ts's "one auditable boundary" rule true
//     for probes that fill from a pool.

import type { Action } from '../ir';
import { invokeAction, type InvokeActionOptions, type InvokeResult, type ToolCallTarget } from '../mcpTools';
import { resolveParams } from '../transient';
import type { ProbeContext } from './types';

export const PROBE_USER_AGENT = 'docentapi-probe/1.0 (+https://www.docentapi.xyz)';
export const STEP_TIMEOUT_MS = 8_000;

export function probeTarget(ctx: ProbeContext): ToolCallTarget {
  return {
    baseUrls: ctx.baseUrlOverride ? [ctx.baseUrlOverride] : ctx.record.baseUrls,
    authIn: ctx.record.authIn,
  };
}

// requireAuth defaults to FALSE for probes. The MCP surface must never forward
// an unauthenticated request a caller did not ask for, so invokeAction refuses
// one by default — and every probe inherited that refusal, which meant an API
// that declares auth got zero live calls whenever no key was available: the
// call was thrown away client-side, counted as a failure, and never reached
// the wire. A probe is different: a read sent without a key either answers
// (the Petstore demo declares OAuth and enforces nothing) or says 401, and the
// 401 is itself the observation authClarity exists to record.
export function probeInvokeOpts(extra: InvokeActionOptions = {}): InvokeActionOptions {
  return { timeoutMs: STEP_TIMEOUT_MS, userAgent: PROBE_USER_AGENT, requireAuth: false, ...extra };
}

export type CallProbeOptions = InvokeActionOptions & {
  /** Override the key for this call: `null` sends none (the auth-clarity control). */
  upstreamKey?: string | null;
};

export async function callProbe(
  ctx: ProbeContext,
  action: Action,
  params: Record<string, unknown>,
  extra: CallProbeOptions = {},
): Promise<InvokeResult> {
  const invoke = ctx.invoke ?? invokeAction;
  const { upstreamKey, ...opts } = extra;
  const key = upstreamKey === undefined ? ctx.upstreamKey : upstreamKey ?? undefined;
  return invoke(action, resolveParams(params), probeTarget(ctx), key, probeInvokeOpts(opts));
}
