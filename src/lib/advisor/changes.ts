// check_freshness and get_changes_since — the two tools that let an agent ask
// whether what it learned is still true.
//
// Why an agent needs this at all: MCP clients approve a tool once and cache the
// list; a September 2026 crawl of 248 public MCP servers found tool schemas
// changing in place with byte-identical descriptions, which no client notices.
// DocentAPI's tools are derived from spec versions, so the same thing happens
// here whenever a provider ships. check_freshness hands the agent a fingerprint
// it can compare, and get_changes_since tells it what moved.
//
// Both are pure and synchronous over the pre-loaded AdvisorContext, like every
// other advisor tool: the DB read happens once per request in insights.ts.

import { mcpExposedActions } from '../ir';
import { buildToolList } from '../toolList';
import { SEVERITIES, type Severity } from '../changes/diff';
import { fingerprintTools } from '../changes/fingerprint';
import { ADVISOR_TOOLS } from './descriptors';
import { asData, type AdvisorContext } from './types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_WINDOW_DAYS = 30;
const HASH_PREFIX = /^[0-9a-f]{6,64}$/i;

const EPHEMERAL_NOTE =
  'This is an ephemeral import with no stored history, so no changes can be reported. Persist the API to track its contract over time.';

export type GetChangesSinceArgs = { since?: unknown; severity?: unknown; limit?: unknown };

export function getChangesSince(ctx: AdvisorContext, args: GetChangesSinceArgs) {
  const { recent, summary } = ctx.insights.changes;
  if (!summary) return { changes: [], count: 0, basis: 'no stored change history', note: EPHEMERAL_NOTE };

  const rawLimit = typeof args.limit === 'number' ? Math.floor(args.limit) : NaN;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(MAX_LIMIT, rawLimit)) : DEFAULT_LIMIT;

  const severity = typeof args.severity === 'string' ? args.severity.trim() : '';
  if (severity && !(SEVERITIES as readonly string[]).includes(severity)) {
    return { error: `severity must be one of: ${SEVERITIES.join(', ')}` };
  }

  const rawSince = typeof args.since === 'string' ? args.since.trim() : '';
  let sinceMs: number;
  let basis: string;

  if (!rawSince) {
    sinceMs = Date.now() - DEFAULT_WINDOW_DAYS * 24 * 3600 * 1000;
    basis = `the last ${DEFAULT_WINDOW_DAYS} days`;
  } else if (HASH_PREFIX.test(rawSince)) {
    // Resolved against the loaded rows rather than the DB, because the handler
    // is synchronous. A prefix older than the loaded window cannot be resolved
    // here, and saying so is better than silently returning everything.
    const prefix = rawSince.toLowerCase();
    const match = recent.find((r) => r.toContentHash?.toLowerCase().startsWith(prefix));
    if (!match) {
      return {
        error: `No change in the recorded history landed in a spec version starting with "${asData(rawSince, 64)}". Call docentapi_check_freshness for the current version, or pass an ISO timestamp.`,
      };
    }
    sinceMs = Date.parse(match.observedAt);
    basis = `spec version ${match.toContentHash?.slice(0, 12)}`;
  } else {
    const parsed = Date.parse(rawSince);
    if (!Number.isFinite(parsed)) {
      return { error: 'since must be an ISO timestamp or a spec-version content-hash prefix.' };
    }
    sinceMs = parsed;
    basis = `since ${new Date(parsed).toISOString()}`;
  }

  const matched = recent.filter(
    (r) => Date.parse(r.observedAt) >= sinceMs && (!severity || r.severity === severity),
  );
  const changes = matched.slice(0, limit);

  let highest: Severity | null = null;
  for (const c of changes) {
    if (highest === null || SEVERITIES.indexOf(c.severity) < SEVERITIES.indexOf(highest)) highest = c.severity;
  }

  return {
    basis,
    count: changes.length,
    truncated: matched.length > changes.length,
    highest,
    changes: changes.map((c) => ({
      observedAt: c.observedAt,
      kind: c.kind,
      severity: c.severity,
      // How we know — a spec diff, a live response header, a probe.
      source: c.source,
      // Every one of these is third-party text from a spec, so it is capped
      // and control-stripped before it reaches a model's context (LLM01/LLM10).
      tool: asData(c.tool, 120),
      method: asData(c.method, 12),
      path: asData(c.path, 200),
      fieldPath: c.fieldPath ? asData(c.fieldPath, 200) : null,
      location: c.location,
      summary: asData(c.summary, 300),
      specVersion: c.toContentHash?.slice(0, 12) ?? null,
    })),
    note:
      changes.length === 0
        ? 'No recorded changes in this window. That means none were detected, not that none happened — see lastCheckedAt from docentapi_check_freshness for when the spec was last compared against its source.'
        : 'Severity describes the effect on an EXISTING integration: breaking = a call that worked can now fail; risky = it may; additive = safe; cosmetic = prose only.',
  };
}

export function checkFreshness(ctx: AdvisorContext) {
  const { summary } = ctx.insights.changes;
  const verified = ctx.insights.verified;

  // Fingerprints exactly what tools/list serves: the same advisor descriptors
  // and the same collision-resolved, safety-filtered endpoint tools.
  const tools = [...ADVISOR_TOOLS, ...buildToolList(mcpExposedActions(ctx.record))];
  const { combined } = fingerprintTools(tools);

  return {
    specVersion: summary?.currentVersionHash?.slice(0, 12) ?? null,
    lastCheckedAt: summary?.lastCheckedAt ?? null,
    lastSpecChangeAt: summary?.lastSpecChangeAt ?? null,
    changes30d: summary?.counts30d ?? null,
    verified: verified
      ? {
          total: verified.total,
          verifiedAt: verified.verifiedAt,
          // The whole point of the version fence, restated for an agent: the
          // score is real, and it may describe a contract that has moved.
          stale: verified.stale,
        }
      : null,
    toolFingerprint: combined,
    toolCount: tools.length,
    // What has been OBSERVED, as opposed to documented, at the API level —
    // the per-operation detail is on get_endpoint_schema and describe_fields.
    observed: {
      operationsSampled: ctx.insights.observedShapes.length,
      operationsWithRateLimitPolicy: new Set(ctx.insights.rateLimits.map((r) => r.actionId)).size,
      ...(ctx.insights.rateLimits.length
        ? {
            tightestRateLimit: (() => {
              const t = ctx.insights.rateLimits.reduce((best, r) =>
                r.windowSeconds !== null && (best.windowSeconds === null || r.limit / r.windowSeconds < best.limit / best.windowSeconds)
                  ? r
                  : best,
              );
              return { limit: t.limit, windowSeconds: t.windowSeconds };
            })(),
          }
        : {}),
    },
    basis: summary ? 'stored change history for this API' : 'ephemeral import — no stored history',
    note: summary
      ? 'toolFingerprint is a SHA-256 over every tool name, description, input schema, and annotation this server serves. If it differs from the value you cached, the tool surface changed — call docentapi_get_changes_since before reusing anything you learned earlier.'
      : EPHEMERAL_NOTE,
  };
}
