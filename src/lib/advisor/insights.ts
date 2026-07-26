// Loads the evidence an advisor tool can cite, for persistent (Postgres-backed)
// APIs only. Ephemeral imports have no evidence graph to read — advisor tools
// fall back to spec-only answers and label themselves accordingly, so this
// returning empty is a supported state, not a failure.

import { and, desc, eq, inArray } from 'drizzle-orm';
import { dbReady, getDb } from '../db';
import { apis, evidenceFacts, scores } from '../db/schema';
import { parseEvidencePayload, type EvidenceKind } from '../evidence';
import { emptyInsights, type AdvisorInsights } from './types';

const PROBE_KINDS: EvidenceKind[] = [
  'probe.auth_reject',
  'probe.error_quality',
  'probe.doc_drift',
  'probe.idempotency_signal',
];

// Enough to explain a score without unbounded reads on the MCP hot path.
const MAX_FACTS = 200;

export async function loadAdvisorInsights(slug: string): Promise<AdvisorInsights> {
  if (!dbReady()) return emptyInsights();
  const db = getDb();

  const [api] = await db.select({ id: apis.id }).from(apis).where(eq(apis.slug, slug)).limit(1);
  if (!api) return emptyInsights();

  const [scoreRow] = await db.select().from(scores).where(eq(scores.apiId, api.id)).limit(1);
  const facts = await db
    .select({ kind: evidenceFacts.kind, payload: evidenceFacts.payload })
    .from(evidenceFacts)
    .where(and(eq(evidenceFacts.apiId, api.id), inArray(evidenceFacts.kind, PROBE_KINDS)))
    .orderBy(desc(evidenceFacts.observedAt))
    .limit(MAX_FACTS);

  const insights = emptyInsights();

  if (scoreRow) {
    insights.verified = {
      total: scoreRow.total,
      authClarity: scoreRow.authClarity,
      errorQuality: scoreRow.errorQuality,
      docDrift: scoreRow.docDrift,
      idempotency: scoreRow.idempotency,
      explanation: (scoreRow.explanation as Array<{ factId: string; message: string }> | null) ?? [],
      verifiedAt: scoreRow.verifiedAt.toISOString(),
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
      case 'probe.auth_reject': {
        const p = parseEvidencePayload('probe.auth_reject', fact.payload);
        if (p) {
          insights.authObservations.push({ statusObserved: p.statusObserved, expectedAuth: p.expectedAuth });
        }
        break;
      }
      default:
        break;
    }
  }

  return insights;
}
