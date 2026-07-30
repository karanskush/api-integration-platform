// Materializes computeLineage()'s output as evidence_facts rows.
//
// lineage.ts is already fully usable without this: lineageFor() computes the
// graph in-memory in well under a second even for a 300-action API, and every
// advisor tool reads it that way today. This file exists for the two things an
// in-memory-only graph cannot give you — BUILD_PLAN.md's "materialize, don't
// traverse" schema rule, and an audit trail: a stored fact answers "why did
// docentapi link these two fields on 2026-07-01" even after the scoring
// heuristic that produced it has since changed. Nothing currently reads these
// rows back into a live tool response; they exist as the durable record, the
// same relationship score_previews already has to the live-recomputed
// ScorePreviewPanel (see persist.ts's header comment on that pattern).
//
// Same shape as scoreWrite.ts's buildScoreRunStatements(): pure logic against
// the dialect-agnostic Db type, returning plain insert statements the caller
// folds into its own db.batch() — this file never calls .batch() itself.

import { randomUUID } from 'node:crypto';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Db } from './db';
import { evidenceFacts } from './db/schema';
import { computeLineage, type LineageConfidence } from './lineage';
import type { ImportRecord } from './ir';

// A very large API can produce thousands of edges (computeLineage itself caps
// at 5000). Writing all of them on every import/re-import is real database
// cost for marginal value past the first few hundred highest-scored edges, so
// this trims further at the persistence boundary — the live in-memory graph
// used by trace_field/get_call_sequence is unaffected either way.
const MAX_PERSISTED_EDGES = 500;

// evidence_facts.confidence is a continuous 0..1 column shared by every kind
// (see probe.* payloads); lineage edges only ever produce a discrete bucket.
// This maps the bucket onto that shared scale so a cross-kind confidence
// query still ranks sensibly — the discrete `confidence` field inside the
// jsonb payload remains the one every reader actually keys on.
function confidenceScore(confidence: LineageConfidence): number {
  if (confidence === 'high') return 0.9;
  if (confidence === 'medium') return 0.6;
  return 0.3;
}

export type LineageEvidenceInput = {
  apiId: string;
  specVersionId: string;
  record: ImportRecord;
};

export function buildLineageEvidenceStatements(db: Db, input: LineageEvidenceInput): BatchItem<'pg'>[] {
  const { apiId, specVersionId, record } = input;
  const graph = computeLineage(record);
  if (!graph.edges.length) return [];

  const edges = [...graph.edges].sort((a, b) => b.score - a.score).slice(0, MAX_PERSISTED_EDGES);

  return [
    db.insert(evidenceFacts).values(
      edges.map((edge) => ({
        id: randomUUID(),
        apiId,
        specVersionId,
        // A lineage edge spans two actions (producer and consumer), so it has
        // no single row to attach this nullable FK to — both endpoints live in
        // the payload instead, keyed by tool name and field path rather than
        // the actions table uuid (which is exactly how probe evidence already
        // avoids the actionKey-vs-uuid trap; see scoreWrite.ts).
        actionId: null,
        kind: 'graph.field_lineage' as const,
        source: 'parser',
        environment: 'static',
        confidence: confidenceScore(edge.confidence),
        payload: {
          fromTool: edge.from.tool,
          fromField: edge.from.field,
          toTool: edge.to.tool,
          toField: edge.to.field,
          confidence: edge.confidence,
          score: edge.score,
          why: edge.why,
        },
      })),
    ),
  ];
}
