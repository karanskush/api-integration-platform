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
  // An example value withheld at import because it looked like a credential
  // (secretScan.ts). The payload is the record of WHAT was dropped — location,
  // why, a masked hint and a length — and deliberately has no slot that could
  // hold the value, so recording the redaction never becomes a second copy of
  // the secret. Rows carry redaction_status: 'redacted'.
  | 'parser.redacted_example'
  | 'probe.auth_reject'
  | 'probe.error_quality'
  | 'probe.doc_drift'
  | 'probe.idempotency_signal'
  // Whether the API actually accepts a value its own spec declares
  // (probes/valueDomain.ts). `value` is safe to store verbatim, unlike anything
  // the chain runner handles: it came from the provider's PUBLISHED SPEC, not
  // out of a response, so no customer owns it.
  | 'probe.value_domain'
  // The states an entity was actually seen in (probes/stateVocabulary.ts).
  // These values DO come from responses, which is the direction this codebase
  // otherwise refuses to store from — admissible only because the probe keeps
  // nothing that fails a cardinality guard: a field whose distinct values are
  // few and repeat across many records is a vocabulary, one with roughly as
  // many values as records is data and is dropped whole.
  | 'probe.state_vocabulary'
  // Static, spec-derived — computed by lib/lineage.ts, same "no live traffic
  // needed" character as parser.*. Namespaced separately because it isn't a
  // scorePreview check: it's the field-to-field data-flow graph schema.ts's
  // own header comment names as a future kind ("dag_edge ... in Phase 2 — no
  // migration needed for new kinds").
  | 'graph.field_lineage'
  // Deep-analysis pipeline (analyze-crawl / analyze-enrich jobs): text
  // extracted from the provider's own public docs, and the LLM's semantic
  // read over spec + docs together. Both are a step below spec-derived facts
  // in trust — they're inference, not declaration — hence the separate
  // 'llm' source value rather than reusing 'parser'.
  | 'llm.doc_grounding'
  | 'llm.field_semantics'
  // The LLM's disagreement with a structural lineage edge. Deliberately NOT a
  // clarification: it is a claim about DocentAPI's own heuristics, which an API
  // owner has no way to adjudicate. Recording it downgrades the edge at the
  // artifact boundary; it never becomes a question.
  | 'llm.lineage_dispute'
  // A clarification the human answered — the highest trust tier, above both
  // 'parser' and 'llm' sourced facts, since a person confirmed it directly.
  | 'human.clarification'
  // One re-import's diff against the previous version, summarized. The rows
  // themselves live in api_changes (changes/ledger.ts); this fact is the
  // durable, version-fenced receipt that a diff was computed at all — written
  // even when the diff is empty, because "bytes changed, contract did not" is
  // a finding.
  | 'diff.spec_change'
  // A Deprecation / Sunset / Link / vendor lifecycle header observed on a live
  // response during a probe (changes/lifecycle.ts). Provider-asserted, so it
  // sits with the probe.* kinds in trust, and it never affects the score.
  | 'probe.lifecycle_signal'
  // A rate-limit POLICY read off a live response (changes/rateLimit.ts): how
  // many requests per what window. Provider-asserted, never scored. Only the
  // policy is durable — remaining/reset describe one response's position in
  // the window and are noise a minute later, so they are never carried.
  | 'probe.rate_limit'
  // Read-side conformance (probes/conformance.ts, partitions.ts, docDrift.ts).
  | 'probe.response_conformance'
  | 'probe.negative_partition'
  | 'probe.not_found_identity'
  | 'probe.method_support'
  | 'probe.pagination_behavior'
  // Sandbox write probing (probes/writeRunner.ts).
  | 'probe.write_lifecycle';

const parserCheckPayload = z.object({
  points: z.number(),
  maxPoints: z.number(),
  message: z.string(),
});

const redactedExamplePayload = z.object({
  at: z.string(),
  reason: z.enum(['known_prefix', 'private_key', 'jwt', 'sensitive_name', 'high_entropy']),
  hint: z.string(),
  length: z.number(),
});

const valueDomainPayload = z.object({
  actionId: z.string(),
  field: z.string(),
  // Bounded here as well as at the probe: parseEvidencePayload is what every
  // reader goes through, so a row written before the cap existed still cannot
  // hand an unbounded provider string to a consumer.
  value: z.string().max(120),
  accepted: z.boolean(),
  status: z.number(),
});

const stateVocabularyPayload = z.object({
  actionId: z.string(),
  field: z.string(),
  // Bounded at the read boundary for the same reason valueDomainPayload.value
  // is: STATE_VALUE_SHAPE constrains what the sole writer can store today, but
  // parseEvidencePayload is what every reader goes through, and it must not
  // depend on a writer-side regex staying correct to keep an unbounded
  // provider string away from a consumer.
  values: z.array(z.string().max(120)),
  sampleCount: z.number(),
});

const authRejectPayload = z.object({
  statusObserved: z.number(),
  expectedAuth: z.string(),
  // The second control: what the API says to a key that is well-formed but
  // wrong. Absent on rows written before the control existed.
  badKeyStatus: z.number().optional(),
  wwwAuthenticate: z.boolean().optional(),
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

// Both endpoints of a lineage edge, keyed by tool NAME + field PATH — never
// the actions table uuid. A lineage edge spans two actions (producer and
// consumer), so it has no single row to attach evidence_facts.action_id to
// anyway; the endpoints live entirely in this payload, matched back to a
// spec_version's actions by (tool, field) at read time.
const fieldLineagePayload = z.object({
  fromTool: z.string(),
  fromField: z.string(),
  toTool: z.string(),
  toField: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  score: z.number(),
  why: z.array(z.string()),
});

// One crawled page's extracted text, capped and quoted — never rendered or
// prompted as anything but data (see docsCrawler.ts).
const docGroundingPayload = z.object({
  url: z.string(),
  title: z.string().optional(),
  excerpt: z.string(),
});

// One field's LLM-inferred meaning beyond what structural heuristics alone
// can say. `confidenceOverride` is advisory only — see deepEnrich.ts: a
// conflict with a high-confidence heuristic edge becomes a clarification
// instead of either side silently winning.
const fieldSemanticsPayload = z.object({
  tool: z.string(),
  field: z.string(),
  semanticMeaning: z.string(),
  businessConstraint: z.string().optional(),
  confidenceOverride: z.enum(['high', 'medium', 'low']).optional(),
  sourcedFrom: z.enum(['spec', 'docs']),
});

// One disputed lineage edge. `producer` is the exact knownProducers string the
// model was shown ("tool.field (confidence)"), so the dispute can be matched
// back to the edge it refers to without trusting the model to restructure it.
const lineageDisputePayload = z.object({
  tool: z.string(),
  field: z.string(),
  producer: z.string(),
  reason: z.string(),
});

// A clarification question's human-provided answer, materialized as a fact.
const humanClarificationPayload = z.object({
  clarificationId: z.string(),
  question: z.string(),
  answer: z.unknown(),
});

const severityEnum = z.enum(['breaking', 'risky', 'additive', 'cosmetic']);

const specChangePayload = z.object({
  fromSpecVersionId: z.string().nullable(),
  toSpecVersionId: z.string(),
  counts: z.object({ breaking: z.number(), risky: z.number(), additive: z.number(), cosmetic: z.number() }),
  highest: severityEnum.nullable(),
  truncated: z.boolean(),
  toolsChanged: z.number(),
});

// Mirrors changes/lifecycle.ts LifecycleSignal plus the operation it was seen
// on, keyed by tool name + action key the way the other probe.* payloads are.
const lifecycleSignalPayload = z.object({
  actionId: z.string(),
  tool: z.string(),
  method: z.string(),
  path: z.string(),
  kind: z.enum(['deprecated', 'sunset', 'successor', 'vendor_deprecation', 'version']),
  header: z.string(),
  raw: z.string(),
  at: z.string().optional(),
  url: z.string().optional(),
});

const rateLimitPayload = z.object({
  actionId: z.string(),
  tool: z.string(),
  method: z.string(),
  path: z.string(),
  name: z.string().max(64).optional(),
  limit: z.number(),
  windowSeconds: z.number().nullable(),
  header: z.string(),
  // Bounded at the read boundary as well as at the parser, like every other
  // provider string that reaches an agent.
  raw: z.string().max(120),
});

// `satisfies` (rather than a plain annotation) keeps this exhaustive against
// EvidenceKind — adding a kind without adding a schema here is a type error.
const fillSourceEnum = z.enum(['example', 'schema_example', 'default', 'const', 'enum', 'harvested', 'created', 'derived']);

// Every read-side conformance payload is numbers, booleans, enums and schema
// PATHS. No response value has a slot to land in — the same structural rule
// lineage_executions applies with its zero-jsonb table.
const responseConformancePayload = z.object({
  actionId: z.string(),
  status: z.number(),
  contentTypeObserved: z.string().max(120).nullable(),
  contentTypeMatches: z.boolean().nullable(),
  schemaValid: z.boolean().nullable(),
  schemaErrorCount: z.number(),
  schemaErrorPaths: z.array(z.string().max(120)).max(20),
  // Whether a fabricated identifier for this operation was refused. null until
  // the negative control has run; a 2xx to a made-up id means the positive
  // sample proves less than it looks.
  discriminating: z.boolean().nullable(),
  paramSources: z.array(fillSourceEnum).max(24),
});
const negativePartitionPayload = z.object({
  actionId: z.string(),
  partition: z.enum(['omitted_required', 'unknown_id', 'wrong_type', 'enum_violation', 'malformed_format', 'missing_required_header']),
  field: z.string().max(120),
  status: z.number(),
  rejected: z.boolean(),
  matchesErrorSchema: z.boolean().nullable(),
  hasReadableMessage: z.boolean(),
});
const notFoundIdentityPayload = z.object({
  actionId: z.string(),
  status: z.number(),
  identity: z.enum(['not_found_404', 'gone_410', 'rejected_other_4xx', 'soft_404_2xx', 'server_error']),
  controlBasis: z.enum(['fabricated_like_real', 'derived_placeholder']),
  matchesErrorSchema: z.boolean().nullable(),
  hasReadableMessage: z.boolean(),
});
const methodSupportPayload = z.object({
  actionId: z.string(),
  path: z.string().max(200),
  method: z.enum(['OPTIONS', 'HEAD']),
  status: z.number(),
  allowHeaderPresent: z.boolean(),
  allowDeclaredAgreement: z.enum(['agrees', 'allow_superset', 'allow_subset', 'disagrees']).nullable(),
  undeclaredMethods: z.array(z.string().max(7)).max(8),
});
const paginationBehaviorPayload = z.object({
  actionId: z.string(),
  model: z.enum(['cursor', 'page', 'offset']),
  start: z.object({ status: z.number(), items: z.number() }),
  continue: z.object({ status: z.number(), advanced: z.boolean().nullable() }).nullable(),
  cursorReuse: z.object({ status: z.number(), samePage: z.boolean().nullable() }).nullable(),
  skipped: z.enum(['next_is_url', 'no_next', 'no_size_param', 'start_failed']).optional(),
});

// One fact per resource family the write runner exercised. Statuses, enums,
// counts and a step ladder — never a body, never an identifier.
const writeLifecyclePayload = z.object({
  actionId: z.string(),
  entity: z.string().max(64),
  runId: z.string(),
  steps: z.object({
    create: z.number().nullable(),
    read: z.number().nullable(),
    update: z.number().nullable(),
    readAfterUpdate: z.number().nullable(),
    delete: z.number().nullable(),
    readAfterDelete: z.number().nullable(),
  }),
  idSource: z.enum(['body', 'location', 'unavailable']).nullable(),
  convergence: z.enum(['immediate', 'after_poll', 'never', 'not_attempted']),
  pollCount: z.number(),
  schemaValid: z.boolean().nullable(),
  unknownFieldCount: z.number().nullable(),
  serverGeneratedFieldCount: z.number().nullable(),
  updateReflected: z.boolean().nullable(),
  useAfterFree: z.enum(['gone_404', 'gone_410', 'soft_deleted', 'still_readable', 'not_attempted']),
  cleanup: z.enum(['deleted_confirmed', 'deleted_unconfirmed', 'delete_failed', 'quarantined', 'not_created']),
});

const evidenceSchemas = {
  'parser.auth_discoverability': parserCheckPayload,
  'parser.base_url_validity': parserCheckPayload,
  'parser.unsafe_action_ratio': parserCheckPayload,
  'parser.tool_name_quality': parserCheckPayload,
  'parser.redacted_example': redactedExamplePayload,
  'probe.auth_reject': authRejectPayload,
  'probe.error_quality': errorQualityPayload,
  'probe.doc_drift': docDriftPayload,
  'probe.idempotency_signal': idempotencySignalPayload,
  'probe.value_domain': valueDomainPayload,
  'probe.state_vocabulary': stateVocabularyPayload,
  'graph.field_lineage': fieldLineagePayload,
  'llm.doc_grounding': docGroundingPayload,
  'llm.field_semantics': fieldSemanticsPayload,
  'llm.lineage_dispute': lineageDisputePayload,
  'human.clarification': humanClarificationPayload,
  'diff.spec_change': specChangePayload,
  'probe.lifecycle_signal': lifecycleSignalPayload,
  'probe.rate_limit': rateLimitPayload,
  'probe.response_conformance': responseConformancePayload,
  'probe.negative_partition': negativePartitionPayload,
  'probe.not_found_identity': notFoundIdentityPayload,
  'probe.method_support': methodSupportPayload,
  'probe.pagination_behavior': paginationBehaviorPayload,
  'probe.write_lifecycle': writeLifecyclePayload,
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
