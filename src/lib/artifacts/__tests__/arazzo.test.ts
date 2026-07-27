import { describe, expect, it } from 'vitest';
import { petstoreActions, record } from '../../advisor/__tests__/fixtures';
import { buildArazzoDocument } from '../arazzo';

describe('buildArazzoDocument', () => {
  it('produces a valid-shaped Arazzo 1.0.1 document', () => {
    const r = record({ actions: petstoreActions() });
    const doc = buildArazzoDocument(r, 'https://api.petstore.test/openapi.json');

    expect(doc.arazzo).toBe('1.0.1');
    expect(doc.sourceDescriptions).toEqual([{ name: r.name, url: 'https://api.petstore.test/openapi.json', type: 'openapi' }]);
    expect(Array.isArray(doc.workflows)).toBe(true);
  });

  it('builds a workflow for get_pet, needing create_pet (or list_pets) first', () => {
    const r = record({ actions: petstoreActions() });
    const doc = buildArazzoDocument(r, 'https://api.petstore.test/openapi.json');

    const workflow = doc.workflows.find((w) => w.steps.some((s) => s.operationId === 'get_pet'));
    expect(workflow).toBeDefined();
    const stepIds = workflow!.steps.map((s) => s.operationId);
    expect(stepIds).toContain('get_pet');
    expect(stepIds.length).toBeGreaterThan(1); // at least one producer step before it
  });

  it('binds a deterministic POST-create producer natively via $steps...outputs', () => {
    const r = record({ actions: petstoreActions() });
    const doc = buildArazzoDocument(r, 'https://api.petstore.test/openapi.json');

    const workflow = doc.workflows.find((w) => w.steps.some((s) => s.operationId === 'get_pet'));
    const createStep = workflow?.steps.find((s) => s.operationId === 'create_pet');
    const getStep = workflow?.steps.find((s) => s.operationId === 'get_pet');

    if (createStep?.outputs) {
      // If create_pet was chosen as the producer (high-confidence, POST), the
      // consumer's petId parameter should bind to it via a runtime expression
      // rather than only being noted as an extension.
      expect(getStep?.parameters?.some((p) => p.value.startsWith('$steps.create_pet.outputs'))).toBe(true);
    } else {
      // Otherwise (list_pets chosen, or confidence too low) the dependency
      // must still be recorded, just via the extension rather than a binding.
      expect(getStep?.['x-spotcheck-requires']?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('never scripts a destructive operation as a workflow target', () => {
    const r = record({ actions: petstoreActions() });
    const doc = buildArazzoDocument(r, 'https://api.petstore.test/openapi.json');
    const destructiveTargets = doc.workflows.filter((w) => {
      const last = w.steps[w.steps.length - 1];
      const action = r.actions.find((a) => a.name === last.operationId);
      return action?.safety === 'destructive';
    });
    expect(destructiveTargets).toEqual([]);
  });

  it('skips an operation with no traceable dependency entirely', () => {
    const r = record({ actions: petstoreActions() });
    const doc = buildArazzoDocument(r, 'https://api.petstore.test/openapi.json');
    // list_pets has no path/body dependency of its own — it should never be
    // the TARGET (last step) of a workflow.
    const targets = doc.workflows.map((w) => w.steps[w.steps.length - 1].operationId);
    expect(targets).not.toContain('list_pets');
  });

  it('returns an empty workflow list for an API with no traceable dependencies', () => {
    const r = record({
      actions: [
        { id: 'a', name: 'ping', description: 'Health check', method: 'GET', path: '/ping', paramsSchema: { type: 'object', properties: {} }, auth: 'none', safety: 'read', examples: [] },
      ],
    });
    const doc = buildArazzoDocument(r, 'https://api.example.test/openapi.json');
    expect(doc.workflows).toEqual([]);
  });
});
