// Advisor tool registry: descriptors for tools/list, and dispatch for
// tools/call. See TECH_IMPLEMENTATION.md §3.5's "MCP tool strategy" table.
//
// Naming: every advisor tool carries a `spotcheck_` prefix. Endpoint tool names
// come from third-party operationIds, so an unprefixed `search_endpoints` could
// collide with a real operation on somebody's API and silently shadow it. The
// prefix also tells the calling model, from the tool list alone, which tools
// talk to the API and which talk about it.
//
// Every advisor tool is a pure read over the stored model: no upstream request,
// no credential use, no writes. That is why they are exposed unconditionally,
// including for destructive actions that are themselves hidden from MCP —
// describing a dangerous operation is safe, calling it is not.

import type { ToolDescriptor, ToolCallOutcome } from '../mcpTools';
import { generateContractTest } from './contractTest';
import { explainError } from './errors';
import { describeFields, traceField } from './fields';
import { getCallSequence } from './sequence';
import { getEndpointSchema, searchEndpoints } from './search';
import { getScoreExplanation } from './score';
import type { AdvisorContext } from './types';

export const ADVISOR_PREFIX = 'spotcheck_';

const TOOL_NAME_ARG = {
  type: 'string' as const,
  description: 'Tool name exactly as returned by spotcheck_search_endpoints.',
};

function descriptor(
  name: string,
  title: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDescriptor {
  return {
    name: `${ADVISOR_PREFIX}${name}`,
    description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      // Advisor tools answer from Spotcheck's stored model, so they never
      // reach outside this server — unlike endpoint tools.
      openWorldHint: false,
    },
  };
}

export const ADVISOR_TOOLS: ToolDescriptor[] = [
  descriptor(
    'search_endpoints',
    'Search endpoints',
    'Find the operations on this API that match a description, without pulling every tool schema into context. Returns one compact line per match. Start here.',
    {
      query: {
        type: 'string',
        description: 'What you are trying to do, or a resource noun (e.g. "create a customer", "invoice"). Omit to list everything.',
      },
      limit: { type: 'integer', description: 'Maximum results to return (1-50, default 10).' },
      safety: {
        type: 'string',
        enum: ['read', 'write', 'destructive'],
        description: 'Restrict results to one safety class.',
      },
    },
  ),
  descriptor(
    'get_endpoint_schema',
    'Get endpoint schema',
    'Full detail for one operation: parameters and where each goes, request body, documented response and error shapes, auth requirements, safety class, retry safety, and any drift already observed against the live API.',
    { tool: TOOL_NAME_ARG },
    ['tool'],
  ),
  descriptor(
    'describe_fields',
    'Describe fields',
    'Every field an operation accepts or returns, flattened to addressable paths with their types, allowed values, constraints, and — for inputs — where each value is supposed to come from. Use this to answer "what data can I actually send here", especially for a nested request body.',
    {
      tool: TOOL_NAME_ARG,
      direction: {
        type: 'string',
        enum: ['request', 'response', 'error', 'all'],
        description: 'Which side to describe (default request).',
      },
      filter: {
        type: 'string',
        description: 'Only return fields whose path, name, or description contains this substring. Use it on large schemas.',
      },
      limit: { type: 'integer', description: 'Maximum fields per section (1-300, default 60).' },
      includeReadOnly: {
        type: 'boolean',
        description: 'Include server-assigned fields in the request view. Off by default, since they cannot be sent.',
      },
    },
    ['tool'],
  ),
  descriptor(
    'trace_field',
    'Trace a field',
    'Where a value comes from and what accepts it. Given a field name or path, returns the operations whose responses produce it and the operations whose requests consume it, each with the evidence for the link. Call this instead of inventing an identifier — a field with no producer is reported as caller-supplied rather than guessed at.',
    {
      field: {
        type: 'string',
        description: 'A field name ("customerId") or a full path ("body.customer.email").',
      },
      tool: { type: 'string', description: 'Optional: restrict to one operation.' },
      direction: {
        type: 'string',
        enum: ['producers', 'consumers', 'both'],
        description: 'producers = where it comes from; consumers = what accepts it (default both).',
      },
      includeLowConfidence: {
        type: 'boolean',
        description: 'Include weakly-evidenced links. Off by default — a wrong link is worse than a missing one.',
      },
    },
    ['field'],
  ),
  descriptor(
    'get_call_sequence',
    'Get call sequence',
    'The ordered prerequisites for calling an operation: which identifiers it needs, which other operations produce them, and what has to be authenticated first. Call this before invoking any operation whose path contains an identifier, instead of guessing one.',
    { tool: TOOL_NAME_ARG },
    ['tool'],
  ),
  descriptor(
    'explain_error',
    'Explain an error',
    'Map an HTTP status (and optionally the response body) from this API to its likely trigger, whether retrying can possibly help, and the concrete fix. Uses this API\'s own observed error behaviour where a verification run has recorded it.',
    {
      status: { type: 'integer', description: 'The HTTP status code that came back, e.g. 409.' },
      tool: {
        type: 'string',
        description: 'Optional: the tool whose call failed, for operation-specific guidance.',
      },
      responseBody: {
        type: 'string',
        description: 'Optional: the raw response body, so documented error fields can be read out of it.',
      },
    },
    ['status'],
  ),
  descriptor(
    'get_score_explanation',
    'Explain the Agent-Ready Score',
    'Why this API scored what it scored, sub-score by sub-score, with the evidence behind each finding. States explicitly whether the score is verified by live probes or is a static preview.',
    {},
  ),
  descriptor(
    'generate_contract_test',
    'Generate a contract test',
    'Emit a runnable smoke test for one operation that asserts its status class and its documented response fields — the check that catches spec drift in CI. Returns TypeScript, Python, or a bash/curl script.',
    {
      tool: TOOL_NAME_ARG,
      language: {
        type: 'string',
        enum: ['typescript', 'python', 'bash'],
        description: 'Output language (default typescript).',
      },
    },
    ['tool'],
  ),
];

export const ADVISOR_TOOL_NAMES: ReadonlySet<string> = new Set(ADVISOR_TOOLS.map((t) => t.name));

export function isAdvisorTool(name: string): boolean {
  return ADVISOR_TOOL_NAMES.has(name);
}

type Args = Record<string, unknown>;

function result(payload: unknown): ToolCallOutcome {
  // Structured JSON rather than prose: it is unambiguous for the caller to
  // parse, and it keeps third-party spec text inside quoted string fields
  // instead of letting it read as instructions (OWASP LLM01/LLM05).
  const text = JSON.stringify(payload, null, 2);
  const isError = typeof payload === 'object' && payload !== null && 'error' in payload;
  return { content: [{ type: 'text', text }], isError };
}

export function callAdvisorTool(name: string, args: Args, ctx: AdvisorContext): ToolCallOutcome {
  switch (name) {
    case `${ADVISOR_PREFIX}search_endpoints`:
      return result(searchEndpoints(ctx, args));
    case `${ADVISOR_PREFIX}get_endpoint_schema`:
      return result(getEndpointSchema(ctx, args));
    case `${ADVISOR_PREFIX}describe_fields`:
      return result(describeFields(ctx, args));
    case `${ADVISOR_PREFIX}trace_field`:
      return result(traceField(ctx, args));
    case `${ADVISOR_PREFIX}get_call_sequence`:
      return result(getCallSequence(ctx, args));
    case `${ADVISOR_PREFIX}explain_error`:
      return result(explainError(ctx, args));
    case `${ADVISOR_PREFIX}get_score_explanation`:
      return result(getScoreExplanation(ctx));
    case `${ADVISOR_PREFIX}generate_contract_test`:
      return result(generateContractTest(ctx, args));
    default:
      return result({ error: `Unknown advisor tool: ${name}` });
  }
}

export { emptyInsights } from './types';
export type { AdvisorContext, AdvisorInsights } from './types';
