import type { EvidenceFactInput } from '../evidence';
import type { ImportRecord } from '../ir';
import type { invokeAction } from '../mcpTools';
import type { OutboundBudget } from './budget';

// `invoke` is the dependency-injection point every sub-probe must call
// through instead of invokeAction directly — defaults to the real
// invokeAction when omitted, so every probe is unit-testable with zero real
// network calls, mirroring persist.ts's buildPersistStatements/persistApi
// split.
export type ProbeContext = {
  record: ImportRecord;
  upstreamKey?: string;
  invoke?: typeof invokeAction;
  // The run-level outbound ceiling (probes/budget.ts). Optional so every
  // existing probe and test double compiles unchanged, and carrying no values
  // of its own — it is a counter, not a payload. Probes never read it: the
  // budget is enforced by wrapping `invoke`, and this field exists so an
  // orchestrator can pass one down and a runner can report why it stopped.
  budget?: OutboundBudget;
};

export type ProbeOutcome = {
  subscore: number; // always 0-25
  evidence: EvidenceFactInput[];
  insufficientData?: boolean;
};

// Superseded by probes/budget.ts. Kept only so nothing importing it breaks —
// it was never referenced anywhere, which is why the run-level ceiling it was
// meant to be had to be built properly.
/** @deprecated use createBudget()/withBudget() from probes/budget.ts */
export const MAX_PROBED_ACTIONS = 8;
