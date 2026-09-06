// Turns lifecycle headers observed during a probe into evidence facts.
//
// Shared by every probe that receives a live response, because any of them may
// be the one that sees a Deprecation or Sunset header. The facts are recorded
// and NEVER scored: what the provider says about an endpoint's future is not a
// measure of how well the endpoint is documented today, and folding it into
// the score would make the number mean two things at once.

import type { EvidenceFactInput } from '../evidence';
import type { Action } from '../ir';
import { parseLifecycleSignals } from '../changes/lifecycle';

export function lifecycleEvidence(action: Action, headers: Record<string, string> | undefined): EvidenceFactInput[] {
  if (!headers) return [];
  return parseLifecycleSignals(headers).map((signal) => ({
    kind: 'probe.lifecycle_signal' as const,
    source: 'probe',
    actionId: action.id,
    payload: {
      actionId: action.id,
      tool: action.name,
      method: action.method,
      path: action.path,
      kind: signal.kind,
      header: signal.header,
      raw: signal.raw,
      ...(signal.at ? { at: signal.at } : {}),
      ...(signal.url ? { url: signal.url } : {}),
    },
  }));
}

// Two probes can hit the same operation and see the same header; the ledger
// deduplicates on write, but the evidence graph should not carry the copy
// either.
export function dedupeLifecycleEvidence(evidence: EvidenceFactInput[]): EvidenceFactInput[] {
  const seen = new Set<string>();
  return evidence.filter((e) => {
    if (e.kind !== 'probe.lifecycle_signal') return true;
    const p = e.payload as { actionId: string; kind: string; header: string; raw: string };
    const key = `${p.actionId}|${p.kind}|${p.header}|${p.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
