// The advisor tool descriptors — what tools/list serves for the fixed,
// spec-derived half of this server's surface.
//
// Split out of index.ts so it is importable without pulling in the dispatch
// switch: advisor/changes.ts fingerprints the exact tool list an agent sees,
// which means it needs ADVISOR_TOOLS as a value, and index.ts imports
// advisor/changes.ts to dispatch it. Keeping both in one module would make
// that a runtime import cycle.

import type { ToolDescriptor } from '../toolList';

export const ADVISOR_PREFIX = 'docentapi_';

const TOOL_NAME_ARG = {
  type: 'string' as const,
  description: 'Tool name exactly as returned by docentapi_search_endpoints.',
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
      // Advisor tools answer from DocentAPI's stored model, so they never
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
    'Every field an operation accepts or returns, flattened to addressable paths with their types, allowed values, constraints, and — for inputs — where each value is supposed to come from. Where this API has been analysed against its own documentation, a field also carries what it MEANS and any business rule governing it, with the source of that reading. Where the API\'s owner answered a question about a field, it is marked owner-confirmed and their answer overrides our inference — check originSource before trusting an origin. Where a probe has sent each declared value to the live API, the field also reports which ones were actually accepted - a value under allowedObserved.rejected is declared by the spec but not honoured. Use this to answer "what data can I actually send here", especially for a nested request body.',
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
    'The ordered prerequisites for calling an operation: which identifiers it needs, which other operations produce them, and what has to be authenticated first. Where a link has been confirmed by actually running it against the live API, the producer carries a receipt saying so - check derivedFrom and the verified field on each producer to tell a proven link from an inferred one. Call this before invoking any operation whose path contains an identifier, instead of guessing one.',
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
  descriptor(
    'get_workflows',
    'Get workflows',
    'The multi-step flows this API supports: for each operation that has prerequisites, the ordered set of calls that reaches it, which values a previous step supplies automatically, and which ones you still have to choose. Emitted as Arazzo 1.0.1 steps. Call this before planning a multi-call task, instead of inferring an order from endpoint names.',
    {
      workflow: {
        type: 'string',
        description: 'A workflowId from a previous call, to get its full steps. Omit to list all workflows.',
      },
      limit: { type: 'integer', description: 'Maximum workflows to list (1-50, default 25).' },
    },
  ),
  descriptor(
    'get_webhooks',
    'Get webhooks',
    'The events this API EMITS, as the spec declares them: OpenAPI 3.1 webhooks and 3.0 callbacks, with delivery method, description and the top-level payload fields. Call this before building anything that waits for the API to tell you something happened, instead of polling. Pass a name for the full payload schema. Declared, not observed — no delivery has been received.',
    { name: { type: 'string', description: 'A webhook or callback name from the list, for its full payload schema. Omit to list all.' } },
  ),
  descriptor(
    'check_freshness',
    'Check freshness',
    'How current this API model is: which spec version it describes, when the spec was last checked against its source, when it last changed, whether the verified score still applies to the current version, and a fingerprint of this tool list. Call this at the start of a session and compare toolFingerprint with what you cached — MCP tool schemas can change in place without any description changing.',
    {},
  ),
  descriptor(
    'get_changes_since',
    'Get changes since',
    'The classified changes to this API since a date or a spec version: what changed, how severely it can break an existing integration (breaking, risky, additive, cosmetic), and how it was detected. Call this when a call that used to work has started failing, or before relying on behaviour you learned earlier in a session.',
    {
      since: {
        type: 'string',
        description:
          'An ISO timestamp, or a spec-version content-hash prefix as returned by docentapi_check_freshness. Defaults to the last 30 days.',
      },
      severity: {
        type: 'string',
        enum: ['breaking', 'risky', 'additive', 'cosmetic'],
        description: 'Only return changes at this severity.',
      },
      limit: { type: 'integer', description: 'Maximum changes to return (1-100, default 50).' },
    },
  ),
];
