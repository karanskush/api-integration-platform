import type { EvidenceFactInput } from '../evidence';
import type { ImportRecord } from '../ir';
import type { invokeAction } from '../mcpTools';

// `invoke` is the dependency-injection point every sub-probe must call
// through instead of invokeAction directly — defaults to the real
// invokeAction when omitted, so every probe is unit-testable with zero real
// network calls, mirroring persist.ts's buildPersistStatements/persistApi
// split.
export type ProbeContext = {
  record: ImportRecord;
  upstreamKey?: string;
  invoke?: typeof invokeAction;
};

export type ProbeOutcome = {
  subscore: number; // always 0-25
  evidence: EvidenceFactInput[];
  insufficientData?: boolean;
};

export const MAX_PROBED_ACTIONS = 8;
