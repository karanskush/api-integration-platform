// docentapi_get_workflows — the multi-step flows this API supports.
//
// The Arazzo document was already being built on every deep analysis, YAML-
// serialized, uploaded to Blob and recorded on spec_versions.arazzo_blob_ref —
// and then read by nothing at all. getArtifactText() had no call sites outside
// its own test. This is the reader.
//
// It rebuilds the document from the record rather than fetching the stored
// artifact, which is both simpler and strictly better here: buildArazzoDocument
// is pure over the record (its lineage lookup is cached), so this stays a
// synchronous, I/O-free advisor tool like every other one, it works for an
// ephemeral paste that has no stored artifact at all, and it can never serve a
// workflow computed against a superseded spec version. The stored artifact
// remains the durable, versioned copy for download and for tools outside this
// server.
//
// HONESTY: these are derived from the spec's structure, not from anything
// executed. A step order here is a plan, not a receipt, and the payload says so
// — the same discipline get_call_sequence already applies to itself.

import { buildArazzoDocument } from '../artifacts/arazzo';
import { asData, type AdvisorContext } from './types';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

type RequiresNote = { field: string; from: string; confidence: string };

export type GetWorkflowsArgs = { workflow?: unknown; limit?: unknown };

export function getWorkflows(ctx: AdvisorContext, args: GetWorkflowsArgs) {
  const doc = buildArazzoDocument(ctx.record, ctx.record.sourceUrl ?? '');
  const wanted = typeof args.workflow === 'string' ? args.workflow.trim() : '';

  if (wanted) {
    const found = doc.workflows.find((w) => w.workflowId === wanted);
    if (!found) {
      return {
        error: `No workflow named "${asData(wanted, 80)}" exists on this API.`,
        hint: 'Call docentapi_get_workflows with no arguments to list them.',
      };
    }
    return {
      workflowId: found.workflowId,
      summary: asData(found.summary, 300),
      // The Arazzo step objects as-is: an agent that understands the standard
      // can execute them, and one that does not can still read the order.
      steps: found.steps,
      arazzoVersion: doc.arazzo,
      basis: 'spec structure only — no live traffic was observed to build this workflow',
    };
  }

  const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, requested));

  const workflows = doc.workflows.slice(0, limit).map((w) => {
    // A parameter with a `value` is a native Arazzo binding: the previous
    // step's output feeds this one automatically. Anything in
    // x-docentapi-requires is a dependency we found but cannot bind statically
    // — usually "pick one id out of a list" — and the caller has to choose.
    let bound = 0;
    let manual = 0;
    for (const step of w.steps) {
      bound += step.parameters?.length ?? 0;
      manual += ((step['x-docentapi-requires'] as RequiresNote[] | undefined) ?? []).length;
    }
    return {
      workflowId: w.workflowId,
      summary: asData(w.summary, 300),
      stepCount: w.steps.length,
      calls: w.steps.map((s) => s.operationId),
      automaticallyBound: bound,
      callerMustSupply: manual,
    };
  });

  return {
    api: ctx.record.name,
    arazzoVersion: doc.arazzo,
    total: doc.workflows.length,
    returned: workflows.length,
    workflows,
    ...(doc.workflows.length > limit ? { truncated: true } : {}),
    basis: 'spec structure only — no live traffic was observed to build these workflows',
    note:
      'Each workflow is the ordered set of calls needed to reach one operation. "automaticallyBound" counts values a previous step supplies directly; "callerMustSupply" counts dependencies that exist but require you to choose a value — call docentapi_get_call_sequence on the final operation for how to obtain those.',
  };
}
