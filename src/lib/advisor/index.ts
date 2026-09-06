// Advisor tool registry: descriptors for tools/list, and dispatch for
// tools/call. See TECH_IMPLEMENTATION.md §3.5's "MCP tool strategy" table.
//
// Naming: every advisor tool carries a `docentapi_` prefix. Endpoint tool names
// come from third-party operationIds, so an unprefixed `search_endpoints` could
// collide with a real operation on somebody's API and silently shadow it. The
// prefix also tells the calling model, from the tool list alone, which tools
// talk to the API and which talk about it.
//
// Every advisor tool is a pure read over the stored model: no upstream request,
// no credential use, no writes. That is why they are exposed unconditionally,
// including for destructive actions that are themselves hidden from MCP —
// describing a dangerous operation is safe, calling it is not.

import type { ToolCallOutcome } from '../mcpTools';
import { checkFreshness, getChangesSince } from './changes';
import { generateContractTest } from './contractTest';
import { ADVISOR_PREFIX, ADVISOR_TOOLS } from './descriptors';
import { explainError } from './errors';
import { describeFields, traceField } from './fields';
import { getCallSequence } from './sequence';
import { getEndpointSchema, searchEndpoints } from './search';
import { getScoreExplanation } from './score';
import type { AdvisorContext } from './types';

export { ADVISOR_PREFIX, ADVISOR_TOOLS } from './descriptors';

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
    case `${ADVISOR_PREFIX}check_freshness`:
      return result(checkFreshness(ctx));
    case `${ADVISOR_PREFIX}get_changes_since`:
      return result(getChangesSince(ctx, args));
    default:
      return result({ error: `Unknown advisor tool: ${name}` });
  }
}

export { emptyInsights } from './types';
export type { AdvisorContext, AdvisorInsights } from './types';
