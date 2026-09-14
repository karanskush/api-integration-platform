import type { EvidenceFactInput } from '../evidence';
import type { ImportRecord } from '../ir';
import type { invokeAction } from '../mcpTools';
import type { ParamFiller } from '../paramFill';
import type { OutboundBudget } from './budget';

export type ProbeEnvironment = 'production' | 'sandbox';

// `invoke` is the dependency-injection point every sub-probe must call
// through instead of invokeAction directly — defaults to the real
// invokeAction when omitted, so every probe is unit-testable with zero real
// network calls, mirroring persist.ts's buildPersistStatements/persistApi
// split. Probes reach it via context.ts's callProbe().
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
  // How a probe fills parameters it was not given (paramFill.ts). Defaults to
  // the spec-only filler; the engine substitutes a pooled one once ids have
  // been harvested. A function rather than a field of values, so a harvested
  // identifier is reachable only through the closure and never sits on the
  // context where a log line could pick it up.
  fill?: ParamFiller;
  // Which environment the credential in `upstreamKey` belongs to. Stamped on
  // every fact a probe produces; a sandbox observation must never be filed as
  // production truth. Defaults to production.
  environment?: ProbeEnvironment;
  // A declared sandbox host, when the environment has one. Replaces
  // `record.baseUrls[0]` for every call in the run.
  baseUrlOverride?: string;
  // Tags derived placeholder values so they are recognisable in a provider's log.
  runId?: string;
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
