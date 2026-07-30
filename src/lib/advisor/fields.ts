// docentapi_describe_fields and docentapi_trace_field.
//
// These are the two tools that answer the questions an operation-level view
// cannot: "what data can we send it" and "where is this value coming from".
// Both read the pure derivations in lib/fieldMap.ts and lib/lineage.ts, so they
// behave identically for an ephemeral paste and a persisted API.

import { fieldMapFor, originOf, type FieldNode, type FieldMap } from '../fieldMap';
import type { Action } from '../ir';
import { consumersFor, findFieldsByName, lineageFor, producersFor, type LineageEdge } from '../lineage';
import { paginationFor } from '../pagination';
import { asData, type AdvisorContext } from './types';

const DEFAULT_FIELD_LIMIT = 60;
const MAX_FIELD_LIMIT = 300;
const MAX_TRACE_TARGETS = 10;
const MAX_EDGES_REPORTED = 8;

function findAction(ctx: AdvisorContext, name: string): Action | undefined {
  return ctx.record.actions.find((a) => a.name === name);
}

// Compact wire shape. The full FieldNode carries more than an agent needs per
// row, and a 300-field response is already at the edge of useful.
function serialize(field: FieldNode, origin?: string, producers?: LineageEdge[]) {
  return {
    path: field.path,
    type: field.nullable ? `${field.type}|null` : field.type,
    required: field.required,
    ...(field.format ? { format: field.format } : {}),
    ...(field.enum ? { allowed: field.enum } : {}),
    ...(field.const !== undefined ? { mustEqual: field.const } : {}),
    ...(field.pattern ? { pattern: field.pattern } : {}),
    ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
    ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
    ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
    ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
    ...(field.default !== undefined ? { default: field.default } : {}),
    ...(field.example !== undefined ? { example: field.example } : {}),
    ...(field.readOnly ? { readOnly: true } : {}),
    ...(field.writeOnly ? { writeOnly: true } : {}),
    ...(field.deprecated ? { deprecated: true } : {}),
    ...(field.container ? { container: field.container } : {}),
    ...(field.title ? { schemaType: field.title } : {}),
    ...(origin ? { origin } : {}),
    ...(producers?.length
      ? {
          from: producers.slice(0, MAX_EDGES_REPORTED).map((e) => ({
            tool: e.from.tool,
            field: e.from.field,
            confidence: e.confidence,
            why: e.why,
          })),
        }
      : {}),
    ...(field.description ? { description: asData(field.description, 200) } : {}),
  };
}

function matchesFilter(field: FieldNode, filter: string): boolean {
  const needle = filter.toLowerCase();
  return (
    field.path.toLowerCase().includes(needle) ||
    field.name.toLowerCase().includes(needle) ||
    (field.description?.toLowerCase().includes(needle) ?? false)
  );
}

export type DescribeFieldsArgs = {
  tool?: unknown;
  direction?: unknown;
  filter?: unknown;
  limit?: unknown;
  includeReadOnly?: unknown;
};

export function describeFields(ctx: AdvisorContext, args: DescribeFieldsArgs) {
  const wanted = typeof args.tool === 'string' ? args.tool.trim() : '';
  if (!wanted) return { error: 'tool is required — pass the tool name returned by docentapi_search_endpoints.' };

  const action = findAction(ctx, wanted);
  if (!action) return { error: `No operation named "${asData(wanted, 80)}" exists on this API.` };

  const direction =
    args.direction === 'response' || args.direction === 'error' || args.direction === 'all' ? args.direction : 'request';
  const filter = typeof args.filter === 'string' && args.filter.trim() ? args.filter.trim() : null;
  const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_FIELD_LIMIT;
  const limit = Math.max(1, Math.min(MAX_FIELD_LIMIT, requested));
  // readOnly fields are excluded from the request view by default: the whole
  // point of asking "what can I send" is to be told what to send.
  const includeReadOnly = args.includeReadOnly === true;

  const map: FieldMap = fieldMapFor(action);
  const graph = lineageFor(ctx.record);

  const sections: Array<{ key: 'request' | 'response' | 'error'; fields: FieldNode[] }> = [];
  if (direction === 'request' || direction === 'all') sections.push({ key: 'request', fields: map.request });
  if (direction === 'response' || direction === 'all') sections.push({ key: 'response', fields: map.response });
  if (direction === 'error' || direction === 'all') sections.push({ key: 'error', fields: map.errors });

  const out: Record<string, unknown> = {};
  let totalMatched = 0;
  let totalReturned = 0;

  for (const { key, fields } of sections) {
    let selected = fields;
    if (key === 'request' && !includeReadOnly) selected = selected.filter((f) => !f.readOnly);
    if (filter) selected = selected.filter((f) => matchesFilter(f, filter));
    totalMatched += selected.length;

    const page = selected.slice(0, limit);
    totalReturned += page.length;

    out[key] = page.map((field) => {
      if (key !== 'request') return serialize(field);
      const producers = producersFor(graph, action.name, field.path);
      return serialize(field, originOf(field, producers.length > 0), producers);
    });
  }

  const pagination = paginationFor(action, map);
  const writableCount = map.request.filter((f) => !f.readOnly && !f.container).length;
  const serverAssigned = map.request.filter((f) => f.readOnly).map((f) => f.path);

  return {
    tool: action.name,
    call: `${action.method} ${action.path}`,
    direction,
    ...out,
    summary: {
      sendableFields: writableCount,
      ...(serverAssigned.length ? { serverAssigned: serverAssigned.slice(0, 20) } : {}),
      matched: totalMatched,
      returned: totalReturned,
      ...(filter ? { filter } : {}),
    },
    ...(pagination.model !== 'none' || pagination.confidence === 'medium' ? { pagination } : {}),
    ...(map.truncated
      ? {
          truncated: true,
          truncationReason: map.truncationReason,
          note: 'This schema is larger than the inspection limit. Narrow it with the filter argument rather than assuming the omitted fields do not exist.',
        }
      : {}),
    origins: {
      caller_supplied: 'You must provide this value; nothing in this API produces it.',
      produced_by_api: 'Another operation returns it — see the "from" list on the field.',
      server_generated: 'The API assigns it. Do not send it.',
      enum_constrained: 'Pick one of the listed allowed values.',
      constant: 'Exactly one legal value.',
    },
  };
}

export type TraceFieldArgs = {
  field?: unknown;
  tool?: unknown;
  direction?: unknown;
  includeLowConfidence?: unknown;
};

export function traceField(ctx: AdvisorContext, args: TraceFieldArgs) {
  const wanted = typeof args.field === 'string' ? args.field.trim() : '';
  if (!wanted) {
    return { error: 'field is required — a field name like "customerId" or a path like "body.customer.email".' };
  }

  const toolFilter = typeof args.tool === 'string' && args.tool.trim() ? args.tool.trim() : null;
  if (toolFilter && !findAction(ctx, toolFilter)) {
    return { error: `No operation named "${asData(toolFilter, 80)}" exists on this API.` };
  }

  const direction =
    args.direction === 'producers' || args.direction === 'consumers' ? args.direction : 'both';
  const includeLow = args.includeLowConfidence === true;
  const graph = lineageFor(ctx.record, includeLow ? { includeLow: true } : {});

  let matches = findFieldsByName(ctx.record, wanted);
  if (toolFilter) matches = matches.filter((m) => m.tool === toolFilter);

  if (!matches.length) {
    return {
      error: `No field named "${asData(wanted, 80)}" appears anywhere on this API.`,
      hint: 'Use docentapi_describe_fields on an operation to see its exact field paths.',
    };
  }

  const results = matches.slice(0, MAX_TRACE_TARGETS).map(({ tool, field }) => {
    // Always computed in full, regardless of `direction`: `direction` controls
    // what gets DISPLAYED, not what's real. Gating this behind the direction
    // filter made every "consumers"-direction result report
    // origin:"caller_supplied" even for a field with five real producers,
    // because an empty (never-computed) producers array was fed straight into
    // originOf() — found by driving this against the real Swagger Petstore.
    const producers = producersFor(graph, tool, field.path);
    const consumers = consumersFor(graph, tool, field.path);
    const origin = originOf(field, producers.length > 0);

    return {
      tool,
      field: field.path,
      location: field.location,
      type: field.nullable ? `${field.type}|null` : field.type,
      required: field.required,
      ...(field.format ? { format: field.format } : {}),
      ...(field.enum ? { allowed: field.enum } : {}),
      origin,
      // "Where does this come from?"
      ...(direction !== 'consumers'
        ? {
            producedBy: producers.slice(0, MAX_EDGES_REPORTED).map((e) => ({
              tool: e.from.tool,
              field: e.from.field,
              confidence: e.confidence,
              why: e.why,
            })),
          }
        : {}),
      // "What can I do with it?" — the direction an agent plans forward in.
      ...(direction !== 'producers'
        ? {
            consumedBy: consumers.slice(0, MAX_EDGES_REPORTED).map((e) => ({
              tool: e.to.tool,
              field: e.to.field,
              required: e.to.field.startsWith('path.'),
              confidence: e.confidence,
              why: e.why,
            })),
          }
        : {}),
      guidance: guidanceFor(origin, field, producers.length),
    };
  });

  return {
    query: asData(wanted, 120),
    ...(toolFilter ? { tool: toolFilter } : {}),
    matched: matches.length,
    returned: results.length,
    results,
    basis: 'spec structure only — derived from declared schemas, not observed traffic',
    note: includeLow
      ? 'Low-confidence links are included. Treat anything below "high" as a lead to verify, not a fact.'
      : 'Only high and medium confidence links are shown. A field with no producer genuinely has none in this API — do not invent one.',
  };
}

function guidanceFor(origin: string, field: FieldNode, producerCount: number): string {
  switch (origin) {
    case 'server_generated':
      return 'The API assigns this. Do not send it; read it from the response.';
    case 'constant':
      return `This must be exactly ${JSON.stringify(field.const)}.`;
    case 'produced_by_api':
      return `Call one of the ${producerCount} listed operation(s) first and read this value from its response. Do not fabricate it.`;
    case 'enum_constrained':
      return 'Choose one of the allowed values listed above.';
    default:
      return 'Nothing in this API produces this value — it originates with you (or your user). Supplying an invented one will fail or, worse, address the wrong record.';
  }
}
