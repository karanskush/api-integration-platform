// docentapi_get_workflows.
//
// The Arazzo document was built on every deep analysis, serialized, uploaded to
// Blob and recorded on spec_versions.arazzo_blob_ref — then read by nothing:
// getArtifactText() had no call sites outside its own test. This is the reader,
// and it rebuilds from the record rather than fetching the artifact, so it also
// works for an ephemeral paste that has no stored artifact at all.

import { describe, expect, it } from 'vitest';
import { getWorkflows as rawGetWorkflows } from '../workflows';
import type { AdvisorContext } from '../types';
import { ctx, petstoreActions, type Payload } from './fixtures';

const getWorkflows = (c: AdvisorContext, a: Record<string, unknown> = {}): Payload =>
  rawGetWorkflows(c, a);

const petstore = () => ctx(petstoreActions());

describe('listing workflows', () => {
  it('returns the multi-step flows the API supports', () => {
    const result = getWorkflows(petstore());

    expect(result.total).toBeGreaterThan(0);
    expect(result.arazzoVersion).toBe('1.0.1');
    expect(Array.isArray(result.workflows)).toBe(true);
  });

  it('names the ordered calls of each workflow', () => {
    const result = getWorkflows(petstore());
    const flow = (result.workflows as Payload[])[0];

    expect(flow.calls.length).toBe(flow.stepCount);
    // The target operation is the last step, its prerequisites come first.
    expect(flow.stepCount).toBeGreaterThan(1);
  });

  it('separates values a previous step supplies from ones the caller must choose', () => {
    const result = getWorkflows(petstore());
    const flows = result.workflows as Payload[];

    for (const flow of flows) {
      expect(typeof flow.automaticallyBound).toBe('number');
      expect(typeof flow.callerMustSupply).toBe('number');
    }
    // Petstore's dependencies come from GET-list producers, which Arazzo cannot
    // bind statically — "pick one id out of many" is a real choice.
    expect(flows.some((f) => (f.callerMustSupply as number) > 0)).toBe(true);
  });

  it('never scripts a destructive operation', () => {
    const result = getWorkflows(petstore());
    const everyCall = (result.workflows as Payload[]).flatMap((f) => f.calls as string[]);

    expect(everyCall).not.toContain('delete_pet');
  });

  it('honours the limit and says when it truncated', () => {
    const result = getWorkflows(petstore(), { limit: 1 });

    expect((result.workflows as Payload[]).length).toBe(1);
    expect(result.returned).toBe(1);
    if ((result.total as number) > 1) expect(result.truncated).toBe(true);
  });

  it('clamps a nonsense limit rather than throwing', () => {
    expect(() => getWorkflows(petstore(), { limit: -5 })).not.toThrow();
    expect(() => getWorkflows(petstore(), { limit: 'lots' })).not.toThrow();
  });

  // The whole point of the honesty discipline in this codebase: a step order
  // derived from schema structure is a plan, not a receipt.
  it('says its ordering was never executed', () => {
    expect(getWorkflows(petstore()).basis).toContain('no live traffic');
  });
});

describe('fetching one workflow', () => {
  it('returns its Arazzo steps', () => {
    const list = getWorkflows(petstore());
    const id = (list.workflows as Payload[])[0].workflowId as string;

    const one = getWorkflows(petstore(), { workflow: id });
    expect(one.workflowId).toBe(id);
    expect(Array.isArray(one.steps)).toBe(true);
    expect((one.steps as Payload[])[0].stepId).toBeTruthy();
    expect((one.steps as Payload[])[0].operationId).toBeTruthy();
  });

  it('reports an unknown workflow rather than returning nothing', () => {
    const result = getWorkflows(petstore(), { workflow: 'no_such_flow' });

    expect(result.error).toContain('no_such_flow');
    expect(result.hint).toContain('docentapi_get_workflows');
  });
});

describe('an API with no dependencies at all', () => {
  it('reports zero workflows rather than inventing one', () => {
    const standalone = ctx(petstoreActions().filter((a) => a.name === 'list_pets'));
    const result = getWorkflows(standalone);

    expect(result.total).toBe(0);
    expect(result.workflows).toEqual([]);
  });
});
