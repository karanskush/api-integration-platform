import type { EvidenceFactInput } from '../evidence';
import type { ImportRecord } from '../ir';
import { invokeAction } from '../mcpTools';
import type { ProbeContext, ProbeOutcome } from './types';

const FULL = 25;

// Mirrors scorePreview.ts's authDiscoverabilityCheck — full marks for
// none/bearer/basic/a resolvable apiKey placement, partial for an
// unresolved apiKey, low for oauth2 (not headlessly satisfiable from a
// pasted key).
function heuristicSubscore(record: ImportRecord): number {
  switch (record.auth) {
    case 'none':
    case 'bearer':
    case 'basic':
      return FULL;
    case 'apiKey':
      return record.authIn ? FULL : Math.round(FULL * 0.5);
    case 'oauth2':
      return Math.round(FULL * 0.4);
  }
}

export async function runAuthClarity(ctx: ProbeContext): Promise<ProbeOutcome> {
  const { record } = ctx;
  const invoke = ctx.invoke ?? invokeAction;
  const evidence: EvidenceFactInput[] = [];
  const subscore = heuristicSubscore(record);

  const target = record.actions.find((a) => a.safety === 'read');
  if (record.auth !== 'none' && target && record.baseUrls.length) {
    try {
      const result = await invoke(
        target,
        target.examples[0]?.params ?? {},
        { baseUrls: record.baseUrls, authIn: record.authIn },
        undefined,
        { requireAuth: false },
      );
      if (result.status === 401 || result.status === 403) {
        evidence.push({
          kind: 'probe.auth_reject',
          source: 'probe',
          actionId: target.id,
          payload: { statusObserved: result.status, expectedAuth: record.auth },
        });
      }
    } catch {
      // Live call couldn't be made (no key path reachable, SSRF-blocked, spec
      // has no resolvable example, ...) — this is a bonus confirmation on
      // top of the heuristic subscore, so skip it rather than fail the probe.
    }
  }

  return { subscore, evidence };
}
