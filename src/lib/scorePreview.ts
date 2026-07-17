// Cheap static score checks — no probing, no network calls. Computed purely
// from what the normalizer already produced. This is NOT the verified
// Agent-Ready Score (Phase 2, live probes); callers must present it as a
// preview, never as a verified verdict. See TECH_IMPLEMENTATION.md §3/§7.

import type { ImportRecord } from './ir';

export type ScoreCheck = {
  id: string;
  label: string;
  points: number;
  maxPoints: number;
  message: string;
};

export type ScorePreview = {
  total: number; // 0-100
  checks: ScoreCheck[];
};

const POINTS_PER_CHECK = 25;

function authDiscoverabilityCheck(record: ImportRecord): ScoreCheck {
  const max = POINTS_PER_CHECK;
  const id = 'auth_discoverability';
  const label = 'Auth discoverability';

  switch (record.auth) {
    case 'none':
      return { id, label, points: max, maxPoints: max, message: 'No authentication required.' };
    case 'bearer':
    case 'basic':
      return {
        id,
        label,
        points: max,
        maxPoints: max,
        message: `${record.auth} auth is clearly declared and satisfiable from the spec alone.`,
      };
    case 'apiKey':
      return record.authIn
        ? {
            id,
            label,
            points: max,
            maxPoints: max,
            message: `API key auth with a resolvable placement (${record.authIn.in}: ${record.authIn.name}).`,
          }
        : {
            id,
            label,
            points: Math.round(max * 0.5),
            maxPoints: max,
            message: 'API key auth declared, but its header/query placement could not be resolved from the spec.',
          };
    case 'oauth2':
      return {
        id,
        label,
        points: Math.round(max * 0.4),
        maxPoints: max,
        message: 'OAuth2 is declared, but its flow cannot be completed headlessly from a pasted key — agents and BYOK sessions cannot satisfy it from the spec alone.',
      };
  }
}

function baseUrlValidityCheck(record: ImportRecord): ScoreCheck {
  const max = POINTS_PER_CHECK;
  const id = 'base_url_validity';
  const label = 'Base URL validity';
  const n = record.baseUrls.length;
  if (n === 0) {
    return {
      id,
      label,
      points: 0,
      maxPoints: max,
      message: 'No public base URL was found in the spec — playground and MCP calls are disabled until one is added.',
    };
  }
  return { id, label, points: max, maxPoints: max, message: `${n} verified base URL${n === 1 ? '' : 's'} found.` };
}

function unsafeActionRatioCheck(record: ImportRecord): ScoreCheck {
  const max = POINTS_PER_CHECK;
  const id = 'unsafe_action_ratio';
  const label = 'Unsafe action ratio';
  const total = record.counts.total;
  if (total === 0) {
    return { id, label, points: 0, maxPoints: max, message: 'No actions were parsed from this spec.' };
  }
  const ratio = record.counts.destructive / total;
  const points = Math.round(max * (1 - ratio));
  const pct = Math.round(ratio * 100);
  return {
    id,
    label,
    points,
    maxPoints: max,
    message:
      pct === 0
        ? 'No destructive actions detected.'
        : `${pct}% of actions (${record.counts.destructive}/${total}) are destructive and hidden from MCP by default.`,
  };
}

// Names ending in a de-dup suffix (from normalize.ts's uniqueName()) or the
// generic "<method>_root" fallback (from toolName() when a path has no
// meaningful segments) signal the spec lacked usable operationIds.
const COLLISION_SUFFIX = /_\d+$/;
const GENERIC_FALLBACK = /^(get|put|post|delete|patch|head|options)_root$/;

function toolNameQualityCheck(record: ImportRecord): ScoreCheck {
  const max = POINTS_PER_CHECK;
  const id = 'tool_name_quality';
  const label = 'Tool-name quality';
  const total = record.actions.length;
  if (total === 0) {
    return { id, label, points: 0, maxPoints: max, message: 'No actions to name.' };
  }
  const flagged = record.actions.filter((a) => COLLISION_SUFFIX.test(a.name) || GENERIC_FALLBACK.test(a.name));
  const points = Math.round(max * (1 - flagged.length / total));
  return {
    id,
    label,
    points,
    maxPoints: max,
    message:
      flagged.length === 0
        ? 'All tool names are derived cleanly from the spec.'
        : `${flagged.length}/${total} tool names are generic fallbacks or de-duplicated — add operationIds to the spec for cleaner names.`,
  };
}

export function scorePreview(record: ImportRecord): ScorePreview {
  const checks = [
    authDiscoverabilityCheck(record),
    baseUrlValidityCheck(record),
    unsafeActionRatioCheck(record),
    toolNameQualityCheck(record),
  ];
  const total = Math.max(0, Math.min(100, Math.round(checks.reduce((sum, c) => sum + c.points, 0))));
  return { total, checks };
}
