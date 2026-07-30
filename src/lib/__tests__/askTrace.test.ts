// The lime rule, tested per tool.
//
// --verified is EARNED in this product. If a tool merely FINISHING can paint a
// trace row lime, the badge's whole claim is diluted by the Ask surface — so
// this file exists to make that impossible to regress silently.

import { describe, expect, it } from 'vitest';
import {
  ADVISOR_TOOL_NAMES,
  citationsFrom,
  describeToolCall,
  isAdvisorToolName,
  isProbeBacked,
  type AdvisorToolName,
} from '../askTrace';

describe('isProbeBacked — spec-only output is never lime', () => {
  // The default state for most APIs: nothing has been probed. Every tool must
  // report false, including on a perfectly successful call.
  it.each(ADVISOR_TOOL_NAMES)('is false for %s on a plain successful result', (tool) => {
    expect(isProbeBacked(tool, { results: [], steps: [], total: 81 })).toBe(false);
  });

  it('is false for empty, null and non-object output', () => {
    for (const tool of ADVISOR_TOOL_NAMES) {
      expect(isProbeBacked(tool, null)).toBe(false);
      expect(isProbeBacked(tool, 'observed')).toBe(false);
      expect(isProbeBacked(tool, [])).toBe(false);
    }
  });

  // The failure this guards: a spec description that happens to contain the word
  // "observed" must not earn lime. Only the specific structural fields count.
  it('is false when the word "observed" merely appears in spec text', () => {
    expect(
      isProbeBacked('docentapi_describe_fields', {
        fields: [{ field: 'status', description: 'the last observed status of the pet' }],
      }),
    ).toBe(false);
    expect(
      isProbeBacked('docentapi_trace_field', {
        results: [{ field: 'id', note: 'observed in production by the provider' }],
      }),
    ).toBe(false);
  });
});

describe('isProbeBacked — probe evidence earns it', () => {
  it('get_endpoint_schema: observedDrift or an observed retry source', () => {
    expect(isProbeBacked('docentapi_get_endpoint_schema', { observedDrift: { extra: ['x'] } })).toBe(true);
    expect(isProbeBacked('docentapi_get_endpoint_schema', { retry: { source: 'observed' } })).toBe(true);
    expect(isProbeBacked('docentapi_get_endpoint_schema', { retry: { source: 'not_probed' } })).toBe(false);
    expect(isProbeBacked('docentapi_get_endpoint_schema', { retry: { source: 'method_semantics' } })).toBe(false);
  });

  it('explain_error: evidenceBasis observed, but not http_semantics_and_spec', () => {
    expect(isProbeBacked('docentapi_explain_error', { evidenceBasis: 'observed' })).toBe(true);
    expect(isProbeBacked('docentapi_explain_error', { evidenceBasis: 'http_semantics_and_spec' })).toBe(false);
  });

  it('get_call_sequence: any step carrying a verified sentence', () => {
    expect(
      isProbeBacked('docentapi_get_call_sequence', {
        steps: [{ tool: 'a' }, { tool: 'b', verified: 'An unauthenticated request was rejected with HTTP 401.' }],
      }),
    ).toBe(true);
    expect(isProbeBacked('docentapi_get_call_sequence', { steps: [{ tool: 'a' }, { tool: 'b' }] })).toBe(false);
  });

  it('get_score_explanation: the explicit boolean, and nothing looser', () => {
    expect(isProbeBacked('docentapi_get_score_explanation', { verified: true })).toBe(true);
    expect(isProbeBacked('docentapi_get_score_explanation', { verified: false })).toBe(false);
    // Truthy is not true. A string here would be a bug upstream, not a licence.
    expect(isProbeBacked('docentapi_get_score_explanation', { verified: 'yes' })).toBe(false);
  });

  // These four are spec-derived by construction and can never earn lime, no
  // matter what their payload contains.
  it.each([
    'docentapi_search_endpoints',
    'docentapi_describe_fields',
    'docentapi_trace_field',
    'docentapi_generate_contract_test',
  ] as AdvisorToolName[])('%s can never be probe-backed', (tool) => {
    expect(isProbeBacked(tool, { verified: true, evidenceBasis: 'observed', observedDrift: {} })).toBe(false);
  });
});

describe('describeToolCall', () => {
  // The product's honesty claim, said by the trace before the prose says it.
  it('marks a field nothing produces as caller-supplied, in the drift tone', () => {
    const label = describeToolCall(
      'docentapi_trace_field',
      { field: 'petId' },
      { results: [{ field: 'petId', origin: 'caller_supplied', producedBy: [], consumedBy: ['a'] }] },
    );
    expect(label.done).toBe('traced petId');
    expect(label.count).toBe('caller-supplied');
    expect(label.tone).toBe('drift');
  });

  it('counts producers and consumers when the field does have an origin', () => {
    const label = describeToolCall(
      'docentapi_trace_field',
      { field: 'petId', tool: 'get_pet_by_id' },
      { results: [{ origin: 'response', producedBy: ['add_pet'], consumedBy: ['get_pet_by_id', 'delete_pet'] }] },
    );
    expect(label.done).toBe('traced petId in get_pet_by_id');
    expect(label.count).toBe('1 producers, 2 consumers');
    expect(label.tone).toBe('neutral');
  });

  it('flags a search that matched nothing', () => {
    const label = describeToolCall('docentapi_search_endpoints', { query: 'refund' }, { matched: 0 });
    expect(label.count).toBe('nothing matched');
    expect(label.tone).toBe('drift');
  });

  it('truncates a long argument and quotes it typographically', () => {
    const label = describeToolCall(
      'docentapi_search_endpoints',
      { query: 'a'.repeat(60) },
      { matched: 2 },
    );
    expect(label.done).toContain('“');
    expect(label.done).toContain('…');
    expect(label.done.length).toBeLessThan(70);
  });

  // limit changes how much was fetched, not what the answer means.
  it('never surfaces limit as an argument', () => {
    const label = describeToolCall(
      'docentapi_describe_fields',
      { tool: 'add_pet', direction: 'request', limit: 300 },
      { summary: { returned: 6, matched: 61 } },
    );
    expect(label.done).not.toContain('300');
    expect(label.done).toBe('listed add_pet request fields');
    expect(label.count).toBe('6 of 61');
  });

  // An advisor error is a fact about the API, often a more useful one than a
  // success. Surfaced, never swallowed.
  it('surfaces a tool error as the row itself', () => {
    const label = describeToolCall(
      'docentapi_trace_field',
      { field: 'nope' },
      { error: 'No field named "nope" appears on this API.' },
    );
    expect(label.done).toContain('No field named');
    expect(label.tone).toBe('drift');
  });

  it('carries the endpoint through so the row can link to it', () => {
    expect(describeToolCall('docentapi_get_endpoint_schema', { tool: 'add_pet' }, {}).tool).toBe('add_pet');
  });
});

describe('citationsFrom', () => {
  it('deduplicates in first-seen order and ignores calls with no endpoint', () => {
    expect(
      citationsFrom([
        { tool: 'docentapi_search_endpoints', input: { query: 'pet' } },
        { tool: 'docentapi_get_endpoint_schema', input: { tool: 'add_pet' } },
        { tool: 'docentapi_describe_fields', input: { tool: 'get_pet_by_id' } },
        { tool: 'docentapi_get_call_sequence', input: { tool: 'add_pet' } },
      ]),
    ).toEqual(['add_pet', 'get_pet_by_id']);
  });
});

describe('isAdvisorToolName', () => {
  it('accepts every real tool and rejects anything else', () => {
    for (const name of ADVISOR_TOOL_NAMES) expect(isAdvisorToolName(name)).toBe(true);
    expect(isAdvisorToolName('docentapi_evil')).toBe(false);
    expect(isAdvisorToolName('add_pet')).toBe(false);
  });
});
