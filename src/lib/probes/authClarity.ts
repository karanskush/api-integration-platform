import { randomBytes } from 'node:crypto';
import type { EvidenceFactInput } from '../evidence';
import type { ImportRecord } from '../ir';
import { specOnlyFiller } from '../paramFill';
import { callProbe } from './context';
import { lifecycleEvidence } from './lifecycle';
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
  const fill = ctx.fill ?? specOnlyFiller;
  const evidence: EvidenceFactInput[] = [];
  const subscore = heuristicSubscore(record);

  // The first read we can actually build a request for. A read that cannot be
  // filled would fail client-side, and the control needs to reach the API.
  const target = record.actions.find((a) => a.safety === 'read' && fill(a, { runId: ctx.runId }).ok);
  if (record.auth !== 'none' && target && record.baseUrls.length) {
    try {
      const filled = fill(target, { runId: ctx.runId });
      const params = filled.ok ? filled.params : {};
      // Deliberately unauthenticated: the point is to observe whether the live
      // API rejects a request without credentials, rather than trusting the
      // documented scheme.
      const result = await callProbe(ctx, target, params, { upstreamKey: null, requireAuth: false });
      if (result.status === 401 || result.status === 403) {
        // The second control: a key that is well-formed but wrong. An API that
        // rejects a missing key but accepts any string is not enforcing auth,
        // and WWW-Authenticate says whether it tells the caller how to fix it.
        let badKeyStatus: number | undefined;
        try {
          const bad = await callProbe(ctx, target, params, {
            upstreamKey: `docentapi-invalid-${randomBytes(6).toString('hex')}`,
            requireAuth: false,
          });
          badKeyStatus = bad.status;
        } catch {
          // Budget or transport; the first observation stands on its own.
        }
        evidence.push({
          kind: 'probe.auth_reject',
          source: 'probe',
          actionId: target.id,
          payload: {
            statusObserved: result.status,
            expectedAuth: record.auth,
            ...(badKeyStatus !== undefined ? { badKeyStatus } : {}),
            wwwAuthenticate: Boolean(result.headers?.['www-authenticate']),
          },
        });
      }
      // A 401 carries lifecycle headers as readily as a 200 does.
      evidence.push(...lifecycleEvidence(target, result.headers));
    } catch {
      // Live call couldn't be made (SSRF-blocked, unreachable, budget spent)
      // — this is a bonus confirmation on top of the heuristic subscore, so
      // skip it rather than fail the probe.
    }
  }

  return { subscore, evidence };
}
