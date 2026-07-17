import type { EvidenceFactInput } from '../evidence';
import type { Action, JSONSchema } from '../ir';
import { invokeAction } from '../mcpTools';
import type { ProbeContext, ProbeOutcome } from './types';

const FULL = 25;
const SAMPLE_LIMIT = 3;

function jsTypeFor(schemaType: unknown): string | null {
  switch (schemaType) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
    case 'array':
      return 'object';
    default:
      return null;
  }
}

// Shallow: top-level keys and their JS typeof only, no recursion into
// nested shapes — this is a drift smoke test, not a full schema validator.
function compareShallow(responseSchema: JSONSchema, body: unknown) {
  const props = (responseSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const keys = Object.keys(props);
  const mismatches: string[] = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { matched: 0, declared: keys.length, mismatches: keys.map((k) => `missing_field:${k}`) };
  }

  const record = body as Record<string, unknown>;
  let matched = 0;
  for (const key of keys) {
    if (!(key in record)) {
      mismatches.push(`missing_field:${key}`);
      continue;
    }
    const expected = jsTypeFor(props[key]?.type);
    if (expected && typeof record[key] !== expected) {
      mismatches.push(`type_mismatch:${key}`);
      continue;
    }
    matched++;
  }
  return { matched, declared: keys.length, mismatches };
}

function declaredFieldCount(action: Action): number {
  return Object.keys((action.responseSchema?.properties ?? {}) as Record<string, unknown>).length;
}

export async function runDocDrift(ctx: ProbeContext): Promise<ProbeOutcome> {
  const invoke = ctx.invoke ?? invokeAction;
  const target = { baseUrls: ctx.record.baseUrls, authIn: ctx.record.authIn };

  const candidates = ctx.record.actions
    .filter((a) => a.safety === 'read')
    .filter((a) => a.responseSchema && Object.keys(a.examples[0]?.params ?? {}).length > 0)
    .filter((a) => declaredFieldCount(a) > 0)
    .slice(0, SAMPLE_LIMIT);

  if (candidates.length === 0) return { subscore: 0, evidence: [], insufficientData: true };

  const evidence: EvidenceFactInput[] = [];
  let sumRatio = 0;
  for (const action of candidates) {
    let matched = 0;
    let declared = declaredFieldCount(action);
    let mismatches: string[] = Object.keys((action.responseSchema!.properties ?? {}) as Record<string, unknown>).map(
      (k) => `missing_field:${k}`,
    );
    try {
      const res = await invoke(action, action.examples[0].params, target, ctx.upstreamKey);
      const body = JSON.parse(res.bodyText);
      const cmp = compareShallow(action.responseSchema!, body);
      matched = cmp.matched;
      declared = cmp.declared;
      mismatches = cmp.mismatches;
    } catch {
      // no parseable response to compare — grade as a full mismatch below
    }
    sumRatio += declared > 0 ? matched / declared : 0;
    evidence.push({
      kind: 'probe.doc_drift',
      source: 'probe',
      actionId: action.id,
      payload: { actionId: action.id, matchedFields: matched, declaredFields: declared, mismatches },
    });
  }

  return { subscore: Math.round((sumRatio / candidates.length) * FULL), evidence };
}
