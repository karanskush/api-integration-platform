// Evidence taxonomy shared by Phase 1's static parser checks and Phase 2's
// live probe engine. evidence_facts.kind (schema.ts) is untyped text and
// evidence_facts.payload is untyped jsonb — this file is the single place
// that pins both to a closed set of kinds and validates payload shape per
// kind. parser.* kinds mirror scorePreview.ts's ScoreCheck ids (the exact
// shape persist.ts writes: { points, maxPoints, message }); probe.* kinds
// are new in Phase 2.

import { z } from 'zod';

export type EvidenceKind =
  | 'parser.auth_discoverability'
  | 'parser.base_url_validity'
  | 'parser.unsafe_action_ratio'
  | 'parser.tool_name_quality'
  | 'probe.auth_reject'
  | 'probe.error_quality'
  | 'probe.doc_drift'
  | 'probe.idempotency_signal';

const parserCheckPayload = z.object({
  points: z.number(),
  maxPoints: z.number(),
  message: z.string(),
});

const authRejectPayload = z.object({
  statusObserved: z.number(),
  expectedAuth: z.string(),
});

const errorQualityPayload = z.object({
  actionId: z.string(),
  sampleStatus: z.number(),
  hasReadableMessage: z.boolean(),
  snippet: z.string().optional(),
});

const docDriftPayload = z.object({
  actionId: z.string(),
  matchedFields: z.number(),
  declaredFields: z.number(),
  mismatches: z.array(z.string()),
});

const idempotencySignalPayload = z.object({
  actionId: z.string(),
  hasIdempotencySignal: z.boolean(),
  matchedParam: z.string().optional(),
});

// `satisfies` (rather than a plain annotation) keeps this exhaustive against
// EvidenceKind — adding a kind without adding a schema here is a type error.
const evidenceSchemas = {
  'parser.auth_discoverability': parserCheckPayload,
  'parser.base_url_validity': parserCheckPayload,
  'parser.unsafe_action_ratio': parserCheckPayload,
  'parser.tool_name_quality': parserCheckPayload,
  'probe.auth_reject': authRejectPayload,
  'probe.error_quality': errorQualityPayload,
  'probe.doc_drift': docDriftPayload,
  'probe.idempotency_signal': idempotencySignalPayload,
} as const satisfies Record<EvidenceKind, z.ZodTypeAny>;

export type EvidencePayload = {
  [K in EvidenceKind]: z.infer<(typeof evidenceSchemas)[K]>;
};

// Never throws — degrade to null on a shape mismatch, same convention as
// sanitizeSchema in normalize.ts. Callers decide whether a null is fatal.
export function parseEvidencePayload<K extends EvidenceKind>(
  kind: K,
  payload: unknown,
): EvidencePayload[K] | null {
  const result = evidenceSchemas[kind].safeParse(payload);
  return result.success ? (result.data as EvidencePayload[K]) : null;
}

export type EvidenceFactInput = {
  kind: EvidenceKind;
  source: string;
  payload: unknown;
  actionId?: string;
  environment?: string;
  confidence?: number;
};
