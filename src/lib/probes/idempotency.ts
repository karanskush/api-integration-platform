import type { EvidenceFactInput } from '../evidence';
import type { ProbeContext, ProbeOutcome } from './types';

const FULL = 25;
const IDEMPOTENCY_PARAM = /idempotency|request-id|x-request-id/i;

// Static only — never calls a write action live. Grades whether the spec
// even gives an agent a way to make its write calls idempotent, not whether
// the upstream actually behaves idempotently (that would require the
// mutation calls this v1 explicitly never makes).
export async function runIdempotency(ctx: ProbeContext): Promise<ProbeOutcome> {
  const writeActions = ctx.record.actions.filter((a) => a.safety === 'write');
  if (writeActions.length === 0) return { subscore: FULL, evidence: [] };

  const evidence: EvidenceFactInput[] = [];
  let matchedCount = 0;
  for (const action of writeActions) {
    const props = (action.paramsSchema.properties ?? {}) as Record<string, unknown>;
    const matchedParam = Object.keys(props).find((k) => IDEMPOTENCY_PARAM.test(k));
    if (matchedParam) matchedCount++;
    evidence.push({
      kind: 'probe.idempotency_signal',
      source: 'probe',
      actionId: action.id,
      payload: {
        actionId: action.id,
        hasIdempotencySignal: Boolean(matchedParam),
        ...(matchedParam ? { matchedParam } : {}),
      },
    });
  }

  return { subscore: Math.round((matchedCount / writeActions.length) * FULL), evidence };
}
