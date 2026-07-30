// Drizzle schema for Phase 1 (persistence + revenue). See TECH_IMPLEMENTATION.md
// §4 for the original data model sketch this is based on.
//
// Convention: plain `text` columns (not pgEnum) for anything likely to grow a
// new value later — `kind`, `source`, `safety`, `plan` — mirrors how ir.ts
// already serializes AuthScheme/Safety as plain string unions, and avoids
// `ALTER TYPE` ceremony every time Phase 2 introduces a new evidence kind.

import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: id(),
  clerkUserId: text('clerk_user_id').notNull(),
  email: text('email').notNull(),
  githubLogin: text('github_login'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('users_clerk_user_id_idx').on(t.clerkUserId)]);

export const orgs = pgTable('orgs', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  plan: text('plan').notNull().default('free'), // free|launch|pro|team|business
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  stripeSubscriptionStatus: text('stripe_subscription_status'),
  stripePriceId: text('stripe_price_id'),
  seatsIncluded: integer('seats_included').notNull().default(1),
  isSystem: boolean('is_system').notNull().default(false),
  // Same derived-token pattern as apis.ci_token_version (see mcpAccess.ts):
  // the MCP access token that unlocks vaulted credentials is derived, not
  // stored, and bumping this revokes every token issued for the org.
  mcpTokenVersion: integer('mcp_token_version').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('orgs_slug_idx').on(t.slug),
  uniqueIndex('orgs_stripe_customer_id_idx').on(t.stripeCustomerId),
]);

export const orgMembers = pgTable('org_members', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('owner'), // owner|admin|member
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] })]);

// Forward-declared: apis.currentSpecVersionId references specVersions, which
// references apis — declared as plain uuid columns (no FK on the cyclic
// side) and reconciled at the app layer inside persist.ts's transaction.
export const apis = pgTable('apis', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(), // lowercased public URL segment
  name: text('name').notNull(),
  visibility: text('visibility').notNull().default('public'), // public|private (private = Team+)
  claimStatus: text('claim_status').notNull().default('claimed'), // unclaimed|pending|claimed
  // queued|crawling|enriching|needs_input|complete|failed. Default 'complete'
  // (not 'queued') deliberately: every EXISTING write path (claim, ci sync,
  // reimport) skips the deep pipeline entirely and should read as already
  // done. Only the new authenticated /api/apis/analyze route sets 'queued'.
  analysisStatus: text('analysis_status').notNull().default('complete'),
  createdBy: uuid('created_by').references(() => users.id),
  currentSpecVersionId: uuid('current_spec_version_id'),
  baseUrls: jsonb('base_urls').notNull().default([]),
  dominantAuth: text('dominant_auth').notNull().default('none'),
  authIn: jsonb('auth_in'), // {in, name}
  // CI sync tokens are derived, never stored (see ciSync.ts) — this counter is
  // the whole rotation mechanism: bumping it invalidates every token previously
  // issued for this API and nothing else.
  ciTokenVersion: integer('ci_token_version').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('apis_slug_idx').on(t.slug),
  index('apis_org_id_idx').on(t.orgId),
]);

export const specVersions = pgTable('spec_versions', {
  id: id(),
  apiId: uuid('api_id').notNull().references(() => apis.id, { onDelete: 'cascade' }),
  source: text('source').notNull(), // openapi|swagger|postman|curl
  sourceUrl: text('source_url'),
  contentHash: text('content_hash').notNull(), // sha256(raw spec bytes) — the version key
  blobRef: text('blob_ref'), // Vercel Blob pointer to the raw snapshot
  parseStatus: text('parse_status').notNull(), // pending|parsed|failed
  parseError: text('parse_error'),
  actionCount: integer('action_count').notNull().default(0),
  // Populated by the deep-analysis pipeline's finalize stage (and regenerated
  // whenever a clarification answer changes the picture) — Blob pointers to
  // the portable Arazzo workflow file and the x-docentapi-* enriched OpenAPI.
  arazzoBlobRef: text('arazzo_blob_ref'),
  enrichedSpecBlobRef: text('enriched_spec_blob_ref'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('spec_versions_api_id_content_hash_idx').on(t.apiId, t.contentHash),
  index('spec_versions_api_id_idx').on(t.apiId),
]);

export const actions = pgTable('actions', {
  id: id(),
  apiId: uuid('api_id').notNull().references(() => apis.id, { onDelete: 'cascade' }), // denormalized for direct query-by-api
  specVersionId: uuid('spec_version_id').notNull().references(() => specVersions.id, { onDelete: 'cascade' }),
  actionKey: text('action_key').notNull(), // hash(method+path), stable across versions
  name: text('name').notNull(),
  description: text('description').notNull(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  paramsSchema: jsonb('params_schema').notNull(),
  responseSchemas: jsonb('response_schemas'), // null until Phase 2 populates
  errorSchemas: jsonb('error_schemas'),
  scopes: jsonb('scopes'), // string[] of OAuth2 scopes this operation requires, if declared
  auth: text('auth').notNull(),
  authIn: jsonb('auth_in'),
  safety: text('safety').notNull(), // read|write|destructive
  resourceName: text('resource_name'),
  operationStability: text('operation_stability').notNull().default('documented'),
  idempotency: text('idempotency').notNull().default('unknown'),
  requiresConfirmation: boolean('requires_confirmation').notNull().default(false),
  confidence: real('confidence').notNull().default(1),
  examples: jsonb('examples').notNull().default([]),
  enabledForMcp: boolean('enabled_for_mcp').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('actions_spec_version_id_action_key_idx').on(t.specVersionId, t.actionKey),
  index('actions_api_id_spec_version_id_idx').on(t.apiId, t.specVersionId),
]);

export const evidenceFacts = pgTable('evidence_facts', {
  id: id(),
  apiId: uuid('api_id').notNull().references(() => apis.id, { onDelete: 'cascade' }),
  actionId: uuid('action_id').references(() => actions.id, { onDelete: 'cascade' }), // nullable: API-level facts allowed
  specVersionId: uuid('spec_version_id').references(() => specVersions.id, { onDelete: 'cascade' }),
  // Open-ended: 'parser.auth_scheme' | 'parser.missing_schema' | 'parser.unsafe_action' |
  // 'parser.tool_name_quality' today; 'dag_edge' | 'state_transition' | 'failure_mode' |
  // 'idempotency_probe' | 'schema_diff' | ... in Phase 2 — no migration needed for new kinds.
  kind: text('kind').notNull(),
  source: text('source').notNull(), // spec|probe|correction|ci_sync|parser
  environment: text('environment').notNull().default('static'), // static|sandbox|production
  confidence: real('confidence').notNull().default(1),
  redactionStatus: text('redaction_status').notNull().default('none'), // none|redacted|pending_redaction
  payload: jsonb('payload').notNull(), // shape validated in app code (Zod, keyed by `kind`), not by the DB
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [
  index('evidence_facts_api_id_kind_idx').on(t.apiId, t.kind),
  index('evidence_facts_action_id_idx').on(t.actionId),
  index('evidence_facts_api_id_observed_at_idx').on(t.apiId, t.observedAt),
]);

// One current row per API (not append-only) — Phase 2 adds scores/score_runs
// alongside this table; the renderer prefers `scores` once a row exists there.
export const scorePreviews = pgTable('score_previews', {
  id: id(),
  apiId: uuid('api_id').notNull().references(() => apis.id, { onDelete: 'cascade' }),
  specVersionId: uuid('spec_version_id').notNull().references(() => specVersions.id, { onDelete: 'cascade' }),
  total: integer('total').notNull(), // 0-100
  subscores: jsonb('subscores').notNull(),
  explanation: jsonb('explanation').notNull(), // [{ factId, message }] — every item points at evidence_facts
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('score_previews_api_id_idx').on(t.apiId)]);

// One current row per API (not append-only) — same pattern as scorePreviews.
// authClarity/idempotency are always probed; errorQuality/docDrift are
// nullable when there's insufficient data to probe (excluded from total).
export const scores = pgTable('scores', {
  id: id(),
  apiId: uuid('api_id').notNull().references(() => apis.id, { onDelete: 'cascade' }),
  specVersionId: uuid('spec_version_id').notNull().references(() => specVersions.id, { onDelete: 'cascade' }),
  total: integer('total').notNull(), // 0-100
  authClarity: integer('auth_clarity').notNull(),
  errorQuality: integer('error_quality'), // null = insufficient data to probe, excluded from total
  docDrift: integer('doc_drift'), // null = insufficient data to probe, excluded from total
  idempotency: integer('idempotency').notNull(),
  explanation: jsonb('explanation').notNull(), // [{ factId, message }] — same convention as scorePreviews.explanation
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('scores_api_id_idx').on(t.apiId)]);

export const scoreRuns = pgTable('score_runs', {
  id: id(),
  apiId: uuid('api_id').notNull().references(() => apis.id, { onDelete: 'cascade' }),
  status: text('status').notNull(), // queued|running|succeeded|failed
  probesRun: jsonb('probes_run'),
  findings: jsonb('findings'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [index('score_runs_api_id_started_at_idx').on(t.apiId, t.startedAt)]);

// Team+ credential vault. Envelope-encrypted by vault.ts: `encryptedKey` holds
// the AES-256-GCM ciphertext, `wrappedDek` the per-credential data key sealed
// under an org-scoped KEK, and `kmsKeyId` records WHICH key scheme sealed the
// row so a later migration to a real KMS can proceed row by row. Plaintext
// exists only inside a single vault.ts function call — never in a column, never
// in a log.
export const credentials = pgTable('credentials', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  apiId: uuid('api_id').notNull().references(() => apis.id, { onDelete: 'cascade' }),
  environment: text('environment').notNull(), // production|sandbox
  encryptedKey: text('encrypted_key').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  kmsKeyId: text('kms_key_id').notNull(),
  fingerprint: text('fingerprint').notNull(), // non-reversible; "same key?" checks without revealing it
  hint: text('hint').notNull(), // last 4 chars, for the dashboard
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (t) => [
  // One credential per API per environment: without this, a second POST would
  // silently shadow the first and the MCP path would pick arbitrarily.
  uniqueIndex('credentials_api_environment_idx').on(t.apiId, t.environment),
  index('credentials_org_id_idx').on(t.orgId),
]);

// Append-only audit trail for the vault. §5 makes this a release gate for
// Phase 3, and it is what makes a vaulted credential defensible: every decrypt
// is attributable, and a failed decrypt is as interesting as a successful one.
// `actorHash` is a salted hash of the caller identity, never a raw IP or token.
export const credentialAudit = pgTable('credential_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  credentialId: uuid('credential_id').references(() => credentials.id, { onDelete: 'set null' }),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  apiId: uuid('api_id').references(() => apis.id, { onDelete: 'cascade' }),
  environment: text('environment'),
  // created|rotated|deleted|used|denied|decrypt_failed
  action: text('action').notNull(),
  actorType: text('actor_type').notNull(), // user|mcp|probe|cron
  actorHash: text('actor_hash'),
  detail: text('detail'), // short, never a secret or a response body
  createdAt: createdAt(),
}, (t) => [
  index('credential_audit_org_id_created_at_idx').on(t.orgId, t.createdAt),
  index('credential_audit_credential_id_idx').on(t.credentialId),
]);

// Durable ledger for Pro+ analytics — never read on the request hot path
// ("materialize, don't traverse"); written fire-and-forget via after().
export const mcpCalls = pgTable('mcp_calls', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  apiId: uuid('api_id').notNull().references(() => apis.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }), // denormalized
  tool: text('tool').notNull(),
  status: text('status').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  credits: integer('credits').notNull().default(1),
  callerHash: text('caller_hash'),
  createdAt: createdAt(),
}, (t) => [index('mcp_calls_org_id_created_at_idx').on(t.orgId, t.createdAt)]);

// One row per stage per deep-analysis run (parse|crawl|enrich|finalize) —
// same status vocabulary and observability purpose as score_runs above. This
// is also the idempotency backbone for the QStash job chain: each job route
// checks its own stage's row before doing work, so an at-least-once retry
// after a partial success is a no-op rather than a double write.
export const analysisRuns = pgTable('analysis_runs', {
  id: id(),
  apiId: uuid('api_id').notNull().references(() => apis.id, { onDelete: 'cascade' }),
  specVersionId: uuid('spec_version_id').notNull().references(() => specVersions.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(), // parse|crawl|enrich|finalize
  status: text('status').notNull(), // queued|running|succeeded|failed
  detail: jsonb('detail'), // stage-specific: pages crawled, chunks processed, caps hit, etc. — never silently dropped
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [index('analysis_runs_api_id_started_at_idx').on(t.apiId, t.startedAt)]);

// Open questions the deep-analysis pipeline could not confidently resolve on
// its own — the human-in-the-loop step. An answered row becomes the highest
// trust tier of evidence_facts (source: 'human', confidence: 1), above both
// heuristic (source: 'parser') and LLM-inferred (source: 'llm') facts.
export const clarifications = pgTable('clarifications', {
  id: id(),
  apiId: uuid('api_id').notNull().references(() => apis.id, { onDelete: 'cascade' }),
  specVersionId: uuid('spec_version_id').notNull().references(() => specVersions.id, { onDelete: 'cascade' }),
  actionId: uuid('action_id').references(() => actions.id, { onDelete: 'cascade' }), // nullable: some questions are API-level
  fieldPath: text('field_path'), // e.g. 'body.customer.type' — null for API-level questions
  kind: text('kind').notNull(), // ambiguous_origin|ambiguous_enum|unclear_scope|conflicting_signal
  question: text('question').notNull(),
  options: jsonb('options'), // string[] when multiple-choice; null for free text
  // One question, N sites. `petId` appears on four Petstore operations and the
  // owner's single answer is true for all four, so we ask once and record every
  // site it covers. groupKey is deepEnrich's cluster key (kind|entity|field
  // name); appliesTo is Array<{ tool, fieldPath }>, keyed by action NAME because
  // that is what finalize matches against when marking fields verified.
  groupKey: text('group_key'),
  appliesTo: jsonb('applies_to'),
  // Which archetype's answer space this question uses (see lib/clarify).
  // Defaulted rather than nullable so every row — including the ones already in
  // the table — has a renderable shape.
  archetype: text('archetype').notNull().default('origin_unknown'),
  answerSpec: jsonb('answer_spec'), // { kind, options: [{label, value, ...}], allowOther }
  // Who produced the answer. Only ever 'human' today; the column and the CHECK
  // below exist so that when an LLM triage pass lands it is structurally unable
  // to mark anything answered, rather than merely not doing so.
  answerSource: text('answer_source').notNull().default('human'),
  // Set when triage concluded the evidence already answers this. The question is
  // downgraded, never removed: it still renders, with the sentence relied on and
  // where that sentence came from, and one click puts it back to pending.
  assumedAnswer: jsonb('assumed_answer'),
  assumedBasis: jsonb('assumed_basis'), // { quote, sourceKind, sourceUrl? }
  status: text('status').notNull().default('pending'), // pending|answered|skipped|assumed
  answer: jsonb('answer'),
  answeredBy: uuid('answered_by').references(() => users.id),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index('clarifications_api_id_status_idx').on(t.apiId, t.status),
  index('clarifications_spec_version_status_idx').on(t.specVersionId, t.status),
  // Makes the collapse enforceable rather than merely intended: a retried enrich
  // job cannot re-insert a group that already exists for this spec version.
  uniqueIndex('clarifications_spec_version_group_key_idx')
    .on(t.specVersionId, t.groupKey)
    .where(sql`${t.groupKey} is not null`),
]);

// Zero rows in Phase 1 (everything here is pre-claimed at creation) — exists
// for schema stability ahead of Phase 2's real claim flow.
export const claims = pgTable('claims', {
  id: id(),
  apiId: uuid('api_id').notNull().references(() => apis.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  method: text('method').notNull(), // dns|meta|email
  domain: text('domain').notNull(), // the exact hostname shown in the claim instructions — verify must check this, not re-derive from apis.baseUrls
  token: text('token').notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: createdAt(),
});

export const waitlist = pgTable('waitlist', {
  id: id(),
  email: text('email').notNull(),
  source: text('source'),
  status: text('status').notNull().default('pending'), // pending|invited|converted
  invitedAt: timestamp('invited_at', { withTimezone: true }),
  convertedUserId: uuid('converted_user_id').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('waitlist_email_idx').on(t.email)]);

// Dedupes Stripe webhook redelivery (Stripe retries at-least-once).
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(), // Stripe event id
  type: text('type').notNull(),
  createdAt: createdAt(),
});
