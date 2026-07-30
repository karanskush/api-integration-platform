import { describe, expect, it } from 'vitest';
import { ADVISOR_PREFIX, ADVISOR_TOOLS, callAdvisorTool, isAdvisorTool } from '../index';
import { ctx, petstoreActions } from './fixtures';

const context = ctx(petstoreActions());

function payload(name: string, args: Record<string, unknown> = {}) {
  const outcome = callAdvisorTool(name, args, context);
  return { outcome, data: JSON.parse(outcome.content[0].text) as Record<string, unknown> };
}

describe('advisor registry', () => {
  // Order is the tools/list order, and it is deliberate: search first (the
  // entry point), then the per-operation detail tools, then the field-level
  // ones, then diagnosis and codegen.
  it('exposes exactly the expected tool set, in order', () => {
    expect(ADVISOR_TOOLS.map((t) => t.name)).toEqual([
      'docentapi_search_endpoints',
      'docentapi_get_endpoint_schema',
      'docentapi_describe_fields',
      'docentapi_trace_field',
      'docentapi_get_call_sequence',
      'docentapi_explain_error',
      'docentapi_get_score_explanation',
      'docentapi_generate_contract_test',
    ]);
  });

  it('namespaces every tool so a third-party operationId cannot collide silently', () => {
    for (const tool of ADVISOR_TOOLS) expect(tool.name.startsWith(ADVISOR_PREFIX)).toBe(true);
  });

  it('annotates every advisor tool as read-only and closed-world', () => {
    for (const tool of ADVISOR_TOOLS) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      // Advisor tools answer from stored data and never reach the upstream API.
      expect(tool.annotations.openWorldHint).toBe(false);
    }
  });

  it('gives every tool an object input schema and a non-trivial description', () => {
    for (const tool of ADVISOR_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.annotations.title.length).toBeGreaterThan(0);
    }
  });

  it('declares required arguments for the tools that need one', () => {
    const byName = new Map(ADVISOR_TOOLS.map((t) => [t.name, t]));
    expect(byName.get('docentapi_get_endpoint_schema')?.inputSchema.required).toEqual(['tool']);
    expect(byName.get('docentapi_get_call_sequence')?.inputSchema.required).toEqual(['tool']);
    expect(byName.get('docentapi_explain_error')?.inputSchema.required).toEqual(['status']);
    expect(byName.get('docentapi_generate_contract_test')?.inputSchema.required).toEqual(['tool']);
    expect(byName.get('docentapi_describe_fields')?.inputSchema.required).toEqual(['tool']);
    expect(byName.get('docentapi_trace_field')?.inputSchema.required).toEqual(['field']);
    expect(byName.get('docentapi_search_endpoints')?.inputSchema.required).toBeUndefined();
    expect(byName.get('docentapi_get_score_explanation')?.inputSchema.required).toBeUndefined();
  });

  it('recognises its own tool names and nothing else', () => {
    expect(isAdvisorTool('docentapi_search_endpoints')).toBe(true);
    expect(isAdvisorTool('search_endpoints')).toBe(false);
    expect(isAdvisorTool('get_pet')).toBe(false);
    expect(isAdvisorTool('docentapi_made_up')).toBe(false);
  });
});

describe('callAdvisorTool', () => {
  it('dispatches each registered tool to a real result', () => {
    expect(payload('docentapi_search_endpoints', { query: 'pet' }).data.results).toBeDefined();
    expect(payload('docentapi_get_endpoint_schema', { tool: 'get_pet' }).data.parameters).toBeDefined();
    expect(payload('docentapi_get_call_sequence', { tool: 'get_pet' }).data.steps).toBeDefined();
    expect(payload('docentapi_explain_error', { status: 429 }).data.retryable).toBe(true);
    expect(payload('docentapi_get_score_explanation').data.total).toBeTypeOf('number');
    expect(payload('docentapi_generate_contract_test', { tool: 'get_pet' }).data.source).toBeTypeOf('string');
    expect(payload('docentapi_describe_fields', { tool: 'create_pet' }).data.request).toBeDefined();
    expect(payload('docentapi_trace_field', { field: 'petId' }).data.results).toBeDefined();
  });

  it('returns machine-parseable JSON, not prose', () => {
    const { outcome } = payload('docentapi_search_endpoints', { query: 'pet' });
    expect(outcome.content).toHaveLength(1);
    expect(outcome.content[0].type).toBe('text');
    expect(() => JSON.parse(outcome.content[0].text)).not.toThrow();
  });

  it('flags an argument error as isError rather than a silent empty result', () => {
    const { outcome, data } = payload('docentapi_get_endpoint_schema', {});
    expect(outcome.isError).toBe(true);
    expect(data.error).toContain('tool is required');
  });

  it('does not flag a successful call as an error', () => {
    expect(payload('docentapi_search_endpoints', { query: 'pet' }).outcome.isError).toBe(false);
  });

  it('reports an unknown advisor tool instead of throwing', () => {
    const { outcome, data } = payload('docentapi_not_a_tool');
    expect(outcome.isError).toBe(true);
    expect(data.error).toContain('Unknown advisor tool');
  });

  it('tolerates junk argument types without throwing', () => {
    for (const tool of ADVISOR_TOOLS) {
      expect(() =>
        callAdvisorTool(tool.name, { tool: 42, query: null, status: [], limit: {}, language: false }, context),
      ).not.toThrow();
    }
  });
});
