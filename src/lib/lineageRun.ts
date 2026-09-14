// Persists what probes/lineageChain.ts observed, and reads it back.
//
// Same split as canaryRun.ts and scoreWrite.ts, for the same reason: the neon
// -http driver has no interactive transactions, so atomicity comes from one
// db.batch(), and PGlite (which the tests run on) does not implement batch at
// all. buildLineageRunStatements is the pure half every test exercises;
// applyLineageRun is the single line that can only run against Neon.

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Db, NeonDb } from './db';
import { lineageExecutions, lineageRuns } from './db/schema';
import type { ChainObservation, ChainResult } from './probes/lineageChain';
import {
  promoteVerdict,
  type ChainOutcome,
  type EdgeVerification,
  type ExecutionRow,
} from './lineageVerdict';

// Bounded like every other read on the MCP hot path. An API's verified edges
// are far fewer than its fields, so this is generous.
const MAX_EXECUTION_ROWS = 500;

export type LineageRunInput = {
  apiId: string;
  specVersionId: string;
  environment?: string;
  chainsPlanned: number;
  budgetLimit: number;
  result: ChainResult;
};

export type LineageRunStatements = {
  runId: string;
  statements: BatchItem<'pg'>[];
  confirmed: number;
  contradicted: number;
  inconclusive: number;
};

function statusFor(result: ChainResult): string {
  return result.aborted ? 'aborted' : 'succeeded';
}

export function buildLineageRunStatements(db: Db, input: LineageRunInput): LineageRunStatements {
  const { apiId, specVersionId, chainsPlanned, budgetLimit, result } = input;
  const environment = input.environment ?? 'production';
  // Client-side, like every id in persist.ts: batch() cannot reference a
  // previous statement's generated id mid-batch.
  const runId = randomUUID();

  const statements: BatchItem<'pg'>[] = [
    db.insert(lineageRuns).values({
      id: runId,
      apiId,
      specVersionId,
      environment,
      status: statusFor(result),
      chainsPlanned,
      chainsExecuted: result.observations.length,
      requestsMade: result.requestsMade,
      budgetLimit,
      abortedReason: result.aborted,
    }),
  ];

  if (result.observations.length) {
    statements.push(
      db.insert(lineageExecutions).values(
        result.observations.map((o: ChainObservation) => ({
          apiId,
          specVersionId,
          runId,
          environment,
          producerActionKey: o.producerActionKey,
          producerTool: o.producerTool,
          producerField: o.producerField,
          consumerActionKey: o.consumerActionKey,
          consumerTool: o.consumerTool,
          consumerField: o.consumerField,
          inferredConfidence: o.inferredConfidence,
          outcome: o.outcome,
          reason: o.reason,
          attempts: o.attempts,
          successes: o.successes,
          candidateCount: o.candidateCount,
          predominantStatus: o.predominantStatus,
          controlAttempted: o.controlAttempted,
          controlStatus: o.controlStatus,
          latencyP50Ms: o.latencyP50Ms,
        })),
      ),
    );
  }

  const tally = (outcome: ChainOutcome) => result.observations.filter((o) => o.outcome === outcome).length;

  return {
    runId,
    statements,
    confirmed: tally('confirmed'),
    contradicted: tally('contradicted'),
    inconclusive: tally('inconclusive'),
  };
}

export async function applyLineageRun(
  db: NeonDb,
  input: LineageRunInput,
): Promise<Omit<LineageRunStatements, 'statements'>> {
  const { statements, ...rest } = buildLineageRunStatements(db, input);
  await db.batch(statements as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return rest;
}

/** Full-edge identity, so a verdict attaches to one producer→consumer pair. */
export function verdictKey(edge: {
  producerTool: string;
  producerField: string;
  consumerTool: string;
  consumerField: string;
}): string {
  return `${edge.producerTool}.${edge.producerField}->${edge.consumerTool}.${edge.consumerField}`;
}

export type EdgeVerdict = {
  verdict: EdgeVerification;
  attempts: number;
  successes: number;
  stale: boolean;
  observedAt: string;
};

/**
 * The published verdict per edge, derived across every run recorded for it.
 *
 * Reads history rather than a latest-row-per-edge view because refutation
 * requires cross-run agreement (lineageVerdict.ts): one contradicted run is
 * explained just as well by tenancy scoping or a deleted record as by a wrong
 * edge, so a single row can never settle it.
 */
export async function loadEdgeVerdicts(
  db: Db,
  apiId: string,
  currentSpecVersionId: string,
): Promise<Map<string, EdgeVerdict>> {
  const rows = await db
    .select({
      producerTool: lineageExecutions.producerTool,
      producerField: lineageExecutions.producerField,
      consumerTool: lineageExecutions.consumerTool,
      consumerField: lineageExecutions.consumerField,
      outcome: lineageExecutions.outcome,
      specVersionId: lineageExecutions.specVersionId,
      observedAt: lineageExecutions.observedAt,
      attempts: lineageExecutions.attempts,
      successes: lineageExecutions.successes,
    })
    .from(lineageExecutions)
    .where(and(eq(lineageExecutions.apiId, apiId)))
    .orderBy(desc(lineageExecutions.observedAt))
    .limit(MAX_EXECUTION_ROWS);

  const byEdge = new Map<string, ExecutionRow[]>();
  for (const row of rows) {
    const key = verdictKey(row);
    const list = byEdge.get(key);
    const entry: ExecutionRow = {
      outcome: row.outcome as ChainOutcome,
      specVersionId: row.specVersionId,
      observedAt: row.observedAt,
      attempts: row.attempts,
      successes: row.successes,
    };
    if (list) list.push(entry);
    else byEdge.set(key, [entry]);
  }

  const out = new Map<string, EdgeVerdict>();
  for (const [key, history] of byEdge) {
    const promoted = promoteVerdict(history, currentSpecVersionId);
    // `unattempted` is the absence of a row; emitting it would only add noise.
    if (promoted.verdict === 'unattempted') continue;
    const newest = history.reduce((a, b) => (a.observedAt > b.observedAt ? a : b));
    out.set(key, { ...promoted, observedAt: newest.observedAt.toISOString() });
  }
  return out;
}
