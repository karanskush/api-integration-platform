// docentapi_describe_fields and docentapi_trace_field.
//
// These are the two tools that answer the questions an operation-level view
// cannot: "what data can we send it" and "where is this value coming from".
// Both read the pure derivations in lib/fieldMap.ts and lib/lineage.ts, so they
// behave identically for an ephemeral paste and a persisted API.

import { fieldMapFor, originOf, type FieldNode, type FieldMap } from '../fieldMap';
import type { Action } from '../ir';
import { consumersFor, findFieldsByName, lineageFor, producersFor, returnedBy, type LineageEdge } from '../lineage';
import { paginationFor } from '../pagination';
import { asData, type AdvisorContext } from './types';

const DEFAULT_FIELD_LIMIT = 60;
const MAX_FIELD_LIMIT = 300;
const MAX_TRACE_TARGETS = 10;
const MAX_EDGES_REPORTED = 8;

function findAction(ctx: AdvisorContext, name: string): Action | undefined {
  return ctx.record.actions.find((a) => a.name === name);
}

export type FieldSemantics = { meaning: string; constraint?: string; sourcedFrom: 'spec' | 'docs' };

// Compact wire shape. The full FieldNode carries more than an agent needs per
// row, and a 300-field response is already at the edge of useful.
export type OwnerAnswer = { origin?: string; question: string };

/** Which declared values the API actually took, when a probe checked. */
export type ObservedValues = { accepted: string[]; rejected: string[] };

function serialize(
  field: FieldNode,
  origin?: string,
  producers?: LineageEdge[],
  semantics?: FieldSemantics,
  owner?: OwnerAnswer,
  observed?: ObservedValues,
) {
  return {
    path: field.path,
    type: field.nullable ? `${field.type}|null` : field.type,
    required: field.required,
    ...(field.format ? { format: field.format } : {}),
    ...(field.enum ? { allowed: field.enum } : {}),
    // `allowed` above is what the SPEC declares. This is what the API actually
    // did when each declared value was sent — the difference between a document
    // and a contract, and the first time this tool has been able to tell them
    // apart. A value in `rejected` is declared but not honoured.
    ...(observed && (observed.accepted.length || observed.rejected.length)
      ? {
          allowedObserved: {
            ...(observed.accepted.length ? { accepted: observed.accepted } : {}),
            ...(observed.rejected.length ? { rejected: observed.rejected } : {}),
            note: 'Checked by sending each declared value to the live API. Anything under "rejected" is declared by the spec but was not accepted.',
          },
        }
      : {}),
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
    // Whether `origin` above is a person's answer or our own inference. Without
    // this an agent cannot tell a confirmed fact from a heuristic guess, and
    // they are not the same thing to act on.
    ...(origin ? { originSource: owner?.origin ? 'owner' : 'inferred' } : {}),
    ...(owner
      ? {
          ownerConfirmed: true,
          // The question the owner was actually asked, so the confirmation is
          // auditable rather than an unexplained badge.
          ownerAnsweredQuestion: asData(owner.question, 240),
        }
      : {}),
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
    // Derived by the enrichment pass from the provider's own documentation, so
    // it is third-party text twice over (their docs, then a model's reading of
    // them) and goes through asData like every other untrusted string here.
    // `meaningSource` is not decoration: 'docs' means a sentence in the
    // provider's documentation backed this, 'spec' means it was inferred from
    // the schema alone, and an agent should weigh those differently.
    ...(semantics
      ? {
          meaning: asData(semantics.meaning, 300),
          meaningSource: semantics.sourcedFrom,
          ...(semantics.constraint ? { constraint: asData(semantics.constraint, 300) } : {}),
        }
      : {}),
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
  // Narrowed to this operation once, rather than scanning the whole API's
  // semantics per field.
  const semanticsByPath = new Map<string, FieldSemantics>();
  for (const s of ctx.insights.fieldSemantics) {
    if (s.tool !== action.name) continue;
    semanticsByPath.set(s.field, { meaning: s.meaning, constraint: s.constraint, sourcedFrom: s.sourcedFrom });
  }
  // Keyed on the action's stable id, which is what probe evidence carries.
  const observedByPath = new Map<string, ObservedValues>();
  for (const v of ctx.insights.valueDomains) {
    if (v.actionId !== action.id) continue;
    const entry = observedByPath.get(v.field) ?? { accepted: [], rejected: [] };
    const bucket = v.accepted ? entry.accepted : entry.rejected;
    if (!bucket.includes(v.value)) bucket.push(v.value);
    observedByPath.set(v.field, entry);
  }
  const ownerByPath = new Map<string, OwnerAnswer>();
  for (const a of ctx.insights.ownerAnswers) {
    if (a.tool !== action.name) continue;
    ownerByPath.set(a.field, { origin: a.origin, question: a.question });
  }

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
      const semantics = semanticsByPath.get(field.path);
      // Owner answers are only ever raised about request fields, so they are
      // deliberately not consulted for the response and error views — a path
      // that happens to collide there is a different field.
      if (key !== 'request') return serialize(field, undefined, undefined, semantics);
      const producers = producersFor(graph, action.name, field.path);
      const owner = ownerByPath.get(field.path);
      const observed = observedByPath.get(field.path);
      // A person who runs this API outranks our inference about it. Without
      // this the owner could tell us "the server assigns this, ignore what you
      // send" and describe_fields would still answer caller_supplied — while
      // now also claiming it was owner-confirmed, which is worse than never
      // having asked. Same precedence rule as enrichedSpec.ts.
      const origin = owner?.origin ?? originOf(field, producers.length > 0);
      return serialize(field, origin, producers, semantics, owner, observed);
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
      caller_supplied: 'You must provide this value — no operation mints it. It may still be echoed back in responses; docentapi_trace_field reports where.',
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

    // Only when there is no producer edge. With one, `producedBy` already IS
    // the answer and this would be noise; without one, it is the difference
    // between "you invent this value" and "you supply it, and here is where the
    // values already in use can be read".
    const alsoReturnedBy = producers.length ? [] : returnedBy(ctx.record, tool, field.path);

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
      ...(alsoReturnedBy.length
        ? {
            alsoReturnedBy: alsoReturnedBy.slice(0, MAX_EDGES_REPORTED).map((o) => ({
              tool: o.tool,
              field: o.field.path,
            })),
          }
        : {}),
      guidance: guidanceFor(origin, field, producers.length, alsoReturnedBy.length),
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
      : 'Only high and medium confidence links are shown. An empty "producedBy" means no operation MINTS this value — do not invent a source for it. It does NOT mean the field never appears in a response: check "alsoReturnedBy" for operations that return the same field, which is where values already in use can be read.',
  };
}

function guidanceFor(origin: string, field: FieldNode, producerCount: number, echoCount: number): string {
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
      // Two genuinely different situations, and conflating them is what made
      // this tool report a field sitting in five response schemas as one no
      // endpoint returns.
      return echoCount
        ? `No operation mints this value — you choose it. It is not free-form in practice, though: ${echoCount} operation(s) return the same field (see alsoReturnedBy), so call one of those to see the values already in use rather than inventing one.`
        : 'Nothing in this API produces or returns this value — it originates with you (or your user). Supplying an invented one will fail or, worse, address the wrong record.';
  }
}
