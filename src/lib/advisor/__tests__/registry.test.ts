import { describe, expect, it } from 'vitest';
import { ADVISOR_PREFIX, ADVISOR_TOOLS, callAdvisorTool, isAdvisorTool } from '../index';
import { ctx, petstoreActions } from './fixtures';

const context = ctx(petstoreActions());

function payload(name: string, args: Record<string, unknown> = {}) {
  const outcome = callAdvisorTool(name, args, context);
  return { outcome, data: JSON.parse(outcome.content[0].text) as Record<string, unknown> };
}

describe('advisor registry', () => {
  it('exposes exactly the six tools the spec calls for', () => {
    expect(ADVISOR_TOOLS.map((t) => t.name)).toEqual([
      'spotcheck_search_endpoints',
      'spotcheck_get_endpoint_schema',
      'spotcheck_get_call_sequence',
      'spotcheck_explain_error',
      'spotcheck_get_score_explanation',
      'spotcheck_generate_contract_test',
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
    expect(byName.get('spotcheck_get_endpoint_schema')?.inputSchema.required).toEqual(['tool']);
    expect(byName.get('spotcheck_get_call_sequence')?.inputSchema.required).toEqual(['tool']);
    expect(byName.get('spotcheck_explain_error')?.inputSchema.required).toEqual(['status']);
    expect(byName.get('spotcheck_generate_contract_test')?.inputSchema.required).toEqual(['tool']);
    expect(byName.get('spotcheck_search_endpoints')?.inputSchema.required).toBeUndefined();
    expect(byName.get('spotcheck_get_score_explanation')?.inputSchema.required).toBeUndefined();
  });

  it('recognises its own tool names and nothing else', () => {
    expect(isAdvisorTool('spotcheck_search_endpoints')).toBe(true);
    expect(isAdvisorTool('search_endpoints')).toBe(false);
    expect(isAdvisorTool('get_pet')).toBe(false);
    expect(isAdvisorTool('spotcheck_made_up')).toBe(false);
  });
});

describe('callAdvisorTool', () => {
  it('dispatches each registered tool to a real result', () => {
    expect(payload('spotcheck_search_endpoints', { query: 'pet' }).data.results).toBeDefined();
    expect(payload('spotcheck_get_endpoint_schema', { tool: 'get_pet' }).data.parameters).toBeDefined();
    expect(payload('spotcheck_get_call_sequence', { tool: 'get_pet' }).data.steps).toBeDefined();
    expect(payload('spotcheck_explain_error', { status: 429 }).data.retryable).toBe(true);
    expect(payload('spotcheck_get_score_explanation').data.total).toBeTypeOf('number');
    expect(payload('spotcheck_generate_contract_test', { tool: 'get_pet' }).data.source).toBeTypeOf('string');
  });

  it('returns machine-parseable JSON, not prose', () => {
    const { outcome } = payload('spotcheck_search_endpoints', { query: 'pet' });
    expect(outcome.content).toHaveLength(1);
    expect(outcome.content[0].type).toBe('text');
    expect(() => JSON.parse(outcome.content[0].text)).not.toThrow();
  });

  it('flags an argument error as isError rather than a silent empty result', () => {
    const { outcome, data } = payload('spotcheck_get_endpoint_schema', {});
    expect(outcome.isError).toBe(true);
    expect(data.error).toContain('tool is required');
  });

  it('does not flag a successful call as an error', () => {
    expect(payload('spotcheck_search_endpoints', { query: 'pet' }).outcome.isError).toBe(false);
  });

  it('reports an unknown advisor tool instead of throwing', () => {
    const { outcome, data } = payload('spotcheck_not_a_tool');
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
