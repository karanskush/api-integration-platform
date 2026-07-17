import type { EvidenceFactInput } from '../evidence';
import type { ImportRecord } from '../ir';
import { invokeAction } from '../mcpTools';
import { runAuthClarity } from './authClarity';
import { runDocDrift } from './docDrift';
import { runErrorQuality } from './errorQuality';
import { runIdempotency } from './idempotency';
import type { ProbeContext } from './types';

export type ScoreEngineResult = {
  total: number;
  subscores: {
    authClarity: number;
    errorQuality: number | null;
    docDrift: number | null;
    idempotency: number;
  };
  evidence: EvidenceFactInput[];
};

export async function runScoreEngine(
  record: ImportRecord,
  opts: { upstreamKey?: string; invoke?: typeof invokeAction } = {},
): Promise<ScoreEngineResult> {
  const ctx: ProbeContext = { record, upstreamKey: opts.upstreamKey, invoke: opts.invoke };

  const [authClarity, errorQuality, docDrift, idempotency] = await Promise.all([
    runAuthClarity(ctx),
    runErrorQuality(ctx),
    runDocDrift(ctx),
    runIdempotency(ctx),
  ]);

  // Renormalized over only the subscores that actually ran — an API whose
  // spec never documents e.g. a responseSchema (so docDrift can't run) must
  // not be scored as if it silently failed that check.
  const ran = [authClarity, errorQuality, docDrift, idempotency].filter((o) => !o.insufficientData);
  const total = ran.length ? Math.round((ran.reduce((sum, o) => sum + o.subscore, 0) / (ran.length * 25)) * 100) : 0;

  return {
    total,
    subscores: {
      authClarity: authClarity.subscore,
      errorQuality: errorQuality.insufficientData ? null : errorQuality.subscore,
      docDrift: docDrift.insufficientData ? null : docDrift.subscore,
      idempotency: idempotency.subscore,
    },
    evidence: [...authClarity.evidence, ...errorQuality.evidence, ...docDrift.evidence, ...idempotency.evidence],
  };
}
