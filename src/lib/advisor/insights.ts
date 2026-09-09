// Loads the evidence an advisor tool can cite, for persistent (Postgres-backed)
// APIs only. Ephemeral imports have no evidence graph to read — advisor tools
// fall back to spec-only answers and label themselves accordingly, so this
// returning empty is a supported state, not a failure.

import { and, desc, eq, inArray } from 'drizzle-orm';
import { changeSummary, listChanges } from '../changes/query';
import { dbReady, getDb, type Db } from '../db';
import { actions as actionsTable, apis, clarifications, evidenceFacts, scores, operationObservations } from '../db/schema';
// Imported from clarify/archetypes rather than clarify/index: the index
// re-exports triage and synthesize, which import the AI SDK, and this module
// runs on every MCP request that calls a tool.
import { originForAnswer, type AnswerSpec } from '../clarify/archetypes';
import { parseEvidencePayload, type EvidenceKind } from '../evidence';
import type { ObservedShape } from '../changes/observation';
import { loadEdgeVerdicts } from '../lineageRun';
import { emptyInsights, type AdvisorInsights } from './types';

const PROBE_KINDS: EvidenceKind[] = [
  'probe.auth_reject',
  'probe.error_quality',
  'probe.doc_drift',
  'probe.idempotency_signal',
  'probe.value_domain',
  'probe.state_vocabulary',
  'probe.rate_limit',
];

// Enough to explain a score without unbounded reads on the MCP hot path.
const MAX_FACTS = 200;

// Observation rows are one per operation per canary run; the newest per
// operation is the only one that is knowledge. Read enough rows to cover a
// large API's most recent run and dedupe in memory, the way
// canaryRun.loadPreviousSnapshots does.
const MAX_OBSERVATION_ROWS = 300;
const MAX_OBSERVED_OPERATIONS = 100;

// Semantics are per-field rather than per-probe, so a large API produces far
// more of them — read under their own cap instead of competing with the probe
// facts for MAX_FACTS, where whichever kind happened to be written last would
// crowd the other out.
const MAX_SEMANTIC_FACTS = 400;

// A clustered answer fans out across every site in applies_to, so the row
// count is well below the site count. Bounded on the same principle as the
// reads above.
const MAX_ANSWER_ROWS = 200;

// The window docentapi_get_changes_since can answer over. Bounded for the same
// reason MAX_FACTS is: this loads once per MCP request that calls a tool.
const MAX_CHANGES = 100;
const CHANGE_WINDOW_DAYS = 90;

// `db` is optional so the pglite tests can hand in their own connection; the
// MCP route and the ask route keep getting the shared Neon handle.
export async function loadAdvisorInsights(slug: string, injected?: Db): Promise<AdvisorInsights> {
  const db = injected ?? (dbReady() ? getDb() : null);
  if (!db) return emptyInsights();

  const [api] = await db
    .select({ id: apis.id, currentSpecVersionId: apis.currentSpecVersionId })
    .from(apis)
    .where(eq(apis.slug, slug))
    .limit(1);
  if (!api) return emptyInsights();

  const changeSince = new Date(Date.now() - CHANGE_WINDOW_DAYS * 24 * 3600 * 1000);
  const versionId = api.currentSpecVersionId;

  // ONE round trip for everything below. Every read here depends only on
  // api.id and the current version id, both already in hand — so nothing
  // justified issuing them one after another, and that is what was happening:
  // six sequential stages, each a network hop against Neon over HTTP, under
  // every advisor tool call from every agent. hotPathRoundTrips.test.ts pins
  // the count so it cannot quietly creep back.
  const [[scoreRow], recentChanges, summary, facts, semanticFacts, verdicts, answeredRows, observationRows] = await Promise.all([
    db.select().from(scores).where(eq(scores.apiId, api.id)).limit(1),
    listChanges(db, api.id, { limit: MAX_CHANGES, since: changeSince }),
    changeSummary(db, api.id),
    db
      .select({ kind: evidenceFacts.kind, payload: evidenceFacts.payload, observedAt: evidenceFacts.observedAt })
      .from(evidenceFacts)
      .where(and(eq(evidenceFacts.apiId, api.id), inArray(evidenceFacts.kind, PROBE_KINDS)))
      .orderBy(desc(evidenceFacts.observedAt))
      .limit(MAX_FACTS),
    // Version-fenced, unlike the probe read above: a semantic claim names a
    // specific field, and a field described against a superseded spec version
    // may not exist in the current one. Reporting the old meaning would be
    // worse than reporting none, so an API with no current-version enrichment
    // simply gets an empty list.
    versionId
      ? db
          .select({ payload: evidenceFacts.payload })
          .from(evidenceFacts)
          .where(
            and(
              eq(evidenceFacts.apiId, api.id),
              eq(evidenceFacts.specVersionId, versionId),
              eq(evidenceFacts.kind, 'llm.field_semantics'),
            ),
          )
          .orderBy(desc(evidenceFacts.observedAt))
          .limit(MAX_SEMANTIC_FACTS)
      : Promise.resolve([]),
    // Executed-lineage verdicts, derived across runs (refutation needs
    // agreement, so a latest-row view could not express it). Fenced against
    // the current spec version inside loadEdgeVerdicts, which demotes a
    // confirmation to inconclusive once the contract has moved.
    versionId ? loadEdgeVerdicts(db, api.id, versionId) : Promise.resolve(new Map<string, never>()),
    // Answers a person gave. Version-fenced for the same reason semantics are,
    // and restricted to status 'answered' AND answerSource 'human' — the column
    // exists precisely so a triage assumption is structurally unable to arrive
    // here wearing a person's authority.
    versionId
      ? db
          .select({
            actionId: clarifications.actionId,
            fieldPath: clarifications.fieldPath,
            appliesTo: clarifications.appliesTo,
            question: clarifications.question,
            answer: clarifications.answer,
            answerSpec: clarifications.answerSpec,
          })
          .from(clarifications)
          .where(
            and(
              eq(clarifications.apiId, api.id),
              eq(clarifications.specVersionId, versionId),
              eq(clarifications.status, 'answered'),
              eq(clarifications.answerSource, 'human'),
            ),
          )
          .limit(MAX_ANSWER_ROWS)
      : Promise.resolve([]),
    // The canary's newest production observation per operation. Fenced to the
    // current version (a shape observed against a superseded contract says
    // nothing about this one) and to production (a sandbox shape is a
    // different API for this purpose — canaryRun.ts learned that the hard way).
    versionId
      ? db
          .select({
            actionKey: operationObservations.actionKey,
            shape: operationObservations.shape,
            sampleCount: operationObservations.sampleCount,
            observedAt: operationObservations.observedAt,
          })
          .from(operationObservations)
          .where(
            and(
              eq(operationObservations.apiId, api.id),
              eq(operationObservations.specVersionId, versionId),
              eq(operationObservations.environment, 'production'),
            ),
          )
          .orderBy(desc(operationObservations.observedAt))
          .limit(MAX_OBSERVATION_ROWS)
      : Promise.resolve([]),
  ]);

  const insights = emptyInsights();
  insights.changes = { recent: recentChanges, summary };

  if (scoreRow) {
    insights.verified = {
      total: scoreRow.total,
      authClarity: scoreRow.authClarity,
      errorQuality: scoreRow.errorQuality,
      docDrift: scoreRow.docDrift,
      idempotency: scoreRow.idempotency,
      explanation: (scoreRow.explanation as Array<{ factId: string; message: string }> | null) ?? [],
      verifiedAt: scoreRow.verifiedAt.toISOString(),
      stale: scoreRow.specVersionId !== api.currentSpecVersionId,
      specVersionId: scoreRow.specVersionId,
      liveCallsAttempted: scoreRow.liveCallsAttempted,
      liveCallsSucceeded: scoreRow.liveCallsSucceeded,
      observedPoints: scoreRow.observedPoints,
      staticPoints: scoreRow.staticPoints,
    };
  }

  for (const fact of facts) {
    // parseEvidencePayload degrades to null on a shape mismatch rather than
    // throwing, so a malformed historical row can never break a tool call.
    switch (fact.kind as EvidenceKind) {
      case 'probe.error_quality': {
        const p = parseEvidencePayload('probe.error_quality', fact.payload);
        if (p) {
          insights.errorObservations.push({
            actionId: p.actionId,
            status: p.sampleStatus,
            hasReadableMessage: p.hasReadableMessage,
            ...(p.snippet ? { snippet: p.snippet } : {}),
          });
        }
        break;
      }
      case 'probe.doc_drift': {
        const p = parseEvidencePayload('probe.doc_drift', fact.payload);
        if (p) {
          insights.driftObservations.push({
            actionId: p.actionId,
            matchedFields: p.matchedFields,
            declaredFields: p.declaredFields,
            mismatches: p.mismatches,
          });
        }
        break;
      }
      case 'probe.idempotency_signal': {
        const p = parseEvidencePayload('probe.idempotency_signal', fact.payload);
        if (p) {
          insights.idempotencyObservations.push({
            actionId: p.actionId,
            hasIdempotencySignal: p.hasIdempotencySignal,
            ...(p.matchedParam ? { matchedParam: p.matchedParam } : {}),
          });
        }
        break;
      }
      case 'probe.value_domain': {
        const p = parseEvidencePayload('probe.value_domain', fact.payload);
        if (p) {
          insights.valueDomains.push({
            actionId: p.actionId,
            field: p.field,
            value: p.value,
            accepted: p.accepted,
            status: p.status,
          });
        }
        break;
      }
      case 'probe.state_vocabulary': {
        const p = parseEvidencePayload('probe.state_vocabulary', fact.payload);
        if (p) {
          insights.stateVocabularies.push({
            actionId: p.actionId,
            field: p.field,
            values: p.values,
            sampleCount: p.sampleCount,
          });
        }
        break;
      }
      case 'probe.auth_reject': {
        const p = parseEvidencePayload('probe.auth_reject', fact.payload);
        if (p) {
          insights.authObservations.push({ statusObserved: p.statusObserved, expectedAuth: p.expectedAuth });
        }
        break;
      }
      case 'probe.rate_limit': {
        const p = parseEvidencePayload('probe.rate_limit', fact.payload);
        // Facts arrive newest first, and only the current policy is knowledge:
        // an operation whose quota was raised last week should not also report
        // the old one.
        if (p && !insights.rateLimits.some((r) => r.actionId === p.actionId && (r.name ?? '') === (p.name ?? ''))) {
          insights.rateLimits.push({
            actionId: p.actionId,
            ...(p.name ? { name: p.name } : {}),
            limit: p.limit,
            windowSeconds: p.windowSeconds,
            header: p.header,
            observedAt: fact.observedAt.toISOString(),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // Newest observation per operation; rows arrive newest first. Under-floor
  // snapshots are never stored (canary.ts), so every row here was comparable.
  const seenObserved = new Set<string>();
  for (const row of observationRows) {
    if (seenObserved.has(row.actionKey)) continue;
    if (seenObserved.size >= MAX_OBSERVED_OPERATIONS) break;
    seenObserved.add(row.actionKey);
    const shape = (row.shape as ObservedShape | null) ?? {};
    insights.observedShapes.push({
      actionId: row.actionKey,
      sampleCount: row.sampleCount,
      observedAt: row.observedAt.toISOString(),
      fields: Object.entries(shape).map(([path, o]) => ({ path, presentIn: o.presentIn, types: o.types })),
    });
  }

  // (Fetched in the parallel stage above.)
  {
    for (const [key, v] of verdicts) {
      if (v.verdict === 'unattempted') continue;
      insights.lineageVerdicts.push({
        key,
        verdict: v.verdict,
        attempts: v.attempts,
        successes: v.successes,
        stale: v.stale,
        observedAt: v.observedAt,
      });
    }
  }

  // (Fetched in the parallel stage above.) The name lookup below is the one
  // read that genuinely depends on a prior result, and it only runs when there
  // is an un-clustered answer to resolve.
  if (answeredRows.length) {
    // clarifications.action_id is the actions table's row uuid, which is NOT
    // what a tool name is — the same lookup analyze-finalize has to do. Only
    // needed for un-clustered rows; a clustered one carries tool names directly.
    const actionIds = [...new Set(answeredRows.map((r) => r.actionId).filter((id): id is string => id !== null))];
    const nameById = actionIds.length
      ? new Map(
          (
            await db
              .select({ id: actionsTable.id, name: actionsTable.name })
              .from(actionsTable)
              .where(inArray(actionsTable.id, actionIds))
          ).map((a) => [a.id, a.name] as const),
        )
      : new Map<string, string>();

    for (const row of answeredRows) {
      const spec = row.answerSpec as AnswerSpec | null;
      const chosen = typeof row.answer === 'string' ? row.answer : null;
      // Resolved against the option set the question was ASKED with, never
      // against whatever a client sent — answers.ts's rule, applied on read too.
      const origin = spec && chosen ? originForAnswer(spec, chosen) : null;

      // One answer, N sites: a clustered question about `petId` was asked once
      // and is true for every operation that takes it.
      const sites = row.appliesTo as Array<{ tool: string; fieldPath: string }> | null;
      const resolved = Array.isArray(sites) && sites.length
        ? sites.map((s) => ({ tool: s.tool, field: s.fieldPath }))
        : row.actionId && row.fieldPath && nameById.has(row.actionId)
          ? [{ tool: nameById.get(row.actionId)!, field: row.fieldPath }]
          : [];

      for (const site of resolved) {
        insights.ownerAnswers.push({
          tool: site.tool,
          field: site.field,
          ...(origin ? { origin } : {}),
          question: row.question,
        });
      }
    }
  }

  // Newest wins per (tool, field): a re-run of the enrichment pass appends
  // rather than replaces, so without this an agent could be handed a meaning
  // that a later pass already revised.
  const seenSemantics = new Set<string>();
  for (const fact of semanticFacts) {
    const p = parseEvidencePayload('llm.field_semantics', fact.payload);
    if (!p) continue;
    const key = `${p.tool} ${p.field}`;
    if (seenSemantics.has(key)) continue;
    seenSemantics.add(key);
    insights.fieldSemantics.push({
      tool: p.tool,
      field: p.field,
      meaning: p.semanticMeaning,
      ...(p.businessConstraint ? { constraint: p.businessConstraint } : {}),
      sourcedFrom: p.sourcedFrom,
    });
  }

  return insights;
}
