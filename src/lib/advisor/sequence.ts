// get_call_sequence — "what do I have to do before I can call this?"
//
// The single most common way an agent fails an integration is calling
// `GET /pets/{petId}` with a hallucinated petId. The spec already contains the
// answer: `{petId}` sits under the `/pets` collection, and `/pets` has a GET
// that lists them and a POST that creates one. This module walks that
// structure and hands back an ordered plan instead of leaving the model to
// guess where identifiers come from.
//
// Everything here is derived from the normalized model — no network calls, no
// LLM. When a producer genuinely cannot be found the parameter is reported as
// unresolved rather than papered over with a plausible guess (LLM09).

import { fieldMapFor } from '../fieldMap';
import type { Action, ImportRecord } from '../ir';
import { lineageFor, producersFor } from '../lineage';
// Live in lib/resource.ts so lineage.ts can share them without this module and
// that one importing each other.
import { collectionPathFor, isIdLike, resourceOf } from '../resource';
import { asData, paramsOf, type AdvisorContext } from './types';

const MAX_PRODUCERS_PER_PARAM = 4;
// A Stripe-shaped create can declare dozens of required body fields. Emitting a
// step per field would bury the plan, so the rest are pointed at
// describe_fields rather than silently dropped.
const MAX_BODY_STEPS = 8;
const MAX_BODY_FIELDS_LISTED = 25;

// Re-exported to keep this module's public surface (and its tests) unchanged.
export { collectionPathFor, resourceOf };

function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// Shallow-ish walk: an id is normally at the top level of the response, or one
// level down inside `data`/`items`/`results`, or inside array items. Deeper
// than that and a "match" is more likely coincidence than a real producer.
function declaredFields(schema: unknown, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > 3 || typeof schema !== 'object' || schema === null) return out;
  const node = schema as Record<string, unknown>;
  const props = node.properties as Record<string, unknown> | undefined;
  if (props) {
    for (const [key, child] of Object.entries(props)) {
      out.add(key.toLowerCase());
      declaredFields(child, depth + 1, out);
    }
  }
  if (node.items) declaredFields(node.items, depth + 1, out);
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branch = node[key];
    if (Array.isArray(branch)) for (const b of branch) declaredFields(b, depth + 1, out);
  }
  return out;
}

type Producer = {
  tool: string;
  method: string;
  path: string;
  safety: string;
  provides: string;
  confidence: 'high' | 'medium';
};

// Ranks the ways a caller could obtain `param` for `target`.
export function findProducers(record: ImportRecord, target: Action, param: string): Producer[] {
  const collectionPath = collectionPathFor(target.path, param);
  const resource = collectionPath ? resourceOf(collectionPath) : null;
  const wanted = new Set([param.toLowerCase(), snake(param), param.toLowerCase().replace(/_/g, '')]);
  const producers: Producer[] = [];

  for (const action of record.actions) {
    if (action.id === target.id) continue;

    // Strongest signal: this action *is* the collection the id lives in.
    if (collectionPath && action.path === collectionPath) {
      if (action.method === 'GET') {
        producers.push({
          tool: action.name,
          method: action.method,
          path: action.path,
          safety: action.safety,
          provides: `a list of ${resource ?? 'resource'} records to pick an existing ${param} from`,
          confidence: 'high',
        });
        continue;
      }
      if (action.method === 'POST') {
        producers.push({
          tool: action.name,
          method: action.method,
          path: action.path,
          safety: action.safety,
          provides: `a newly created ${resource ?? 'resource'}; read ${param} from its response`,
          confidence: 'high',
        });
        continue;
      }
    }

    // Weaker signal: some other operation documents a field by this name (or a
    // bare `id` on the matching resource) in its response.
    if (!action.responseSchema) continue;
    const fields = declaredFields(action.responseSchema);
    const named = [...wanted].some((w) => fields.has(w));
    const bareId = fields.has('id') && resource !== null && action.path.toLowerCase().includes(resource);
    if (named || bareId) {
      producers.push({
        tool: action.name,
        method: action.method,
        path: action.path,
        safety: action.safety,
        provides: named
          ? `a response documenting "${param}"`
          : `a response documenting an "id" for ${resource}`,
        confidence: 'medium',
      });
    }
  }

  return producers
    .sort((a, b) => {
      if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
      // Reads before writes: discovering an id should not create data.
      if (a.safety !== b.safety) return a.safety === 'read' ? -1 : 1;
      return a.path.length - b.path.length;
    })
    .slice(0, MAX_PRODUCERS_PER_PARAM);
}

// Which of this plan's producer->consumer links were actually executed. Keyed
// the way lineageRun.ts keys them, so a receipt attaches to one specific pair
// rather than to an operation in general.
type Receipt = { verdict: string; successes: number; attempts: number; observedAt: string };

function verificationFor(ctx: AdvisorContext) {
  // Two indexes on purpose. The body-field path knows the producer FIELD (it
  // comes from a lineage edge) and can match exactly. The path-param path goes
  // through findProducers, which ranks producers by URL structure and never
  // carries a field — so it matches on the pair of operations plus the consumer
  // field, which is still specific enough to name one link.
  const exact = new Map<string, Receipt>();
  const loose = new Map<string, Receipt>();
  for (const v of ctx.insights.lineageVerdicts) {
    const receipt = { verdict: v.verdict, successes: v.successes, attempts: v.attempts, observedAt: v.observedAt };
    exact.set(v.key, receipt);
    const [producer, consumer] = v.key.split('->');
    const producerTool = producer.split('.')[0];
    if (producerTool && consumer) loose.set(`${producerTool}->${consumer}`, receipt);
  }

  const describe = (receipt: Receipt | undefined) => {
    if (!receipt) return undefined;
    if (receipt.verdict === 'observed') {
      return {
        verified: 'observed' as const,
        detail: `Executed against the live API on ${receipt.observedAt.slice(0, 10)}: ${receipt.successes} of ${receipt.attempts} identifiers taken from this producer were accepted, and a fabricated one was rejected.`,
      };
    }
    if (receipt.verdict === 'refuted') {
      return {
        verified: 'refuted' as const,
        detail:
          'Executed against the live API and REJECTED across more than one run: identifiers from this producer were not accepted here. Do not rely on this link.',
      };
    }
    return {
      verified: 'inconclusive' as const,
      detail: 'Execution was attempted but proved nothing either way — treat this link as spec-derived.',
    };
  };

  return {
    exact: (key: string) => describe(exact.get(key)),
    pair: (producerTool: string, consumerTool: string, consumerField: string) =>
      describe(loose.get(`${producerTool}->${consumerTool}.${consumerField}`)),
    any: () => exact.size > 0,
    observedCount: () => [...exact.values()].filter((r) => r.verdict === 'observed').length,
  };
}

export type CallSequenceArgs = { tool?: unknown };

export function getCallSequence(ctx: AdvisorContext, args: CallSequenceArgs) {
  const wanted = typeof args.tool === 'string' ? args.tool.trim() : '';
  if (!wanted) return { error: 'tool is required — pass the tool name returned by search_endpoints.' };

  const target = ctx.record.actions.find((a) => a.name === wanted);
  if (!target) return { error: `No operation named "${asData(wanted, 80)}" exists on this API.` };

  const verification = verificationFor(ctx);
  const params = paramsOf(target);
  const steps: Array<Record<string, unknown>> = [];
  const unresolved: string[] = [];
  const notes: string[] = [];
  let order = 0;

  if (target.auth !== 'none') {
    const observed = ctx.insights.authObservations[0];
    steps.push({
      order: ++order,
      purpose: 'Authenticate',
      detail:
        target.auth === 'oauth2'
          ? 'This operation requires OAuth2, which cannot be completed from a pasted key alone — obtain a token out of band first.'
          : `Supply ${target.auth} credentials. Over this MCP server, pass them in the x-docentapi-upstream-key header; they are forwarded to the API and never stored.`,
      ...(target.authIn ?? ctx.record.authIn ? { placement: target.authIn ?? ctx.record.authIn } : {}),
      ...(target.scopes ? { requiredScopes: target.scopes } : {}),
      ...(observed
        ? { verified: `An unauthenticated request was observed being rejected with HTTP ${observed.statusObserved}.` }
        : {}),
    });
  }

  // Path params in path order: a nested id cannot be resolved before its
  // parent, because the parent appears in the child's collection path.
  const pathParams = params
    .filter((p) => p.in === 'path')
    .sort((a, b) => target.path.indexOf(`{${a.name}}`) - target.path.indexOf(`{${b.name}}`));

  const idLikeQueryParams = params.filter((p) => p.in === 'query' && p.required && isIdLike(p.name));

  for (const param of [...pathParams, ...idLikeQueryParams]) {
    const producers = findProducers(ctx.record, target, param.name);
    if (!producers.length) {
      unresolved.push(param.name);
      steps.push({
        order: ++order,
        purpose: `Obtain ${param.name}`,
        parameter: param.name,
        from: [],
        detail:
          'No operation on this API documents where this value comes from. It has to be supplied by the caller — do not invent one.',
      });
      continue;
    }
    steps.push({
      order: ++order,
      purpose: `Obtain ${param.name}`,
      parameter: param.name,
      ...(collectionPathFor(target.path, param.name)
        ? { collection: collectionPathFor(target.path, param.name) }
        : {}),
      from: producers.map((producer) => {
        const receipt = verification.pair(producer.tool, target.name, `path.${param.name}`);
        return receipt ? { ...producer, ...receipt } : producer;
      }),
    });
  }

  // Required BODY fields. Until now the body was a single opaque parameter, so
  // an operation whose real prerequisite was `body.customerId` reported only
  // "you also need: body" — which is exactly the point at which an agent
  // invents an identifier. fieldMap flattens it; lineage says where each value
  // comes from.
  const map = fieldMapFor(target);
  const graph = lineageFor(ctx.record);
  const requiredBodyFields = map.request.filter(
    (f) => f.location === 'body' && f.required && !f.container && !f.readOnly,
  );

  let bodyStepsEmitted = 0;
  const untracedBodyFields: string[] = [];

  for (const field of requiredBodyFields) {
    const edges = producersFor(graph, target.name, field.path);
    if (!edges.length) {
      // Only identifier-shaped fields are worth flagging: a required `email` or
      // `amount` is obviously caller-supplied and saying so is noise.
      if (isIdLike(field.name)) untracedBodyFields.push(field.path);
      continue;
    }
    if (bodyStepsEmitted >= MAX_BODY_STEPS) continue;
    bodyStepsEmitted++;

    steps.push({
      order: ++order,
      purpose: `Obtain ${field.path}`,
      parameter: field.path,
      in: 'body',
      from: edges.slice(0, MAX_PRODUCERS_PER_PARAM).map((e) => {
        const receipt = verification.exact(`${e.from.tool}.${e.from.field}->${target.name}.${field.path}`);
        return {
          tool: e.from.tool,
          field: e.from.field,
          confidence: e.confidence,
          provides: `read "${e.from.field}" from its response`,
          ...(receipt ?? {}),
        };
      }),
    });
  }

  const skippedBodySteps = Math.max(0, requiredBodyFields.filter((f) => producersFor(graph, target.name, f.path).length).length - bodyStepsEmitted);

  // Required inputs that are not path params. Body fields are listed
  // individually rather than as one `body` blob.
  const nonBodyRequired = params.filter((p) => p.required && p.in !== 'path' && p.in !== 'body');
  const alsoRequires = [
    ...nonBodyRequired.map((p) => ({ name: p.name, in: p.in, type: p.type })),
    ...requiredBodyFields.slice(0, MAX_BODY_FIELDS_LISTED).map((f) => ({
      name: f.path,
      in: 'body' as const,
      type: f.type,
      ...(f.enum ? { allowed: f.enum } : {}),
    })),
  ];

  steps.push({
    order: ++order,
    purpose: 'Call the target operation',
    tool: target.name,
    call: `${target.method} ${target.path}`,
    ...(alsoRequires.length ? { alsoRequires } : {}),
    ...(requiredBodyFields.length > MAX_BODY_FIELDS_LISTED
      ? { moreRequiredBodyFields: requiredBodyFields.length - MAX_BODY_FIELDS_LISTED }
      : {}),
  });

  if (target.safety === 'destructive') {
    notes.push(
      'This operation is classified destructive: it is hidden from this MCP server by default and should require explicit human confirmation before any call.',
    );
  } else if (target.safety === 'write') {
    notes.push('This operation writes data. Confirm the inputs before calling it, and check the retry guidance in get_endpoint_schema.');
  }
  if (unresolved.length) {
    notes.push(
      `${unresolved.length} identifier(s) could not be traced to a producing operation: ${unresolved.join(', ')}. Treat them as caller-supplied inputs.`,
    );
  }
  if (untracedBodyFields.length) {
    notes.push(
      `These required body identifiers have no producer on this API: ${untracedBodyFields.join(', ')}. They must come from you — do not invent them.`,
    );
  }
  if (skippedBodySteps > 0) {
    notes.push(
      `${skippedBodySteps} further required body field(s) also have producers; call docentapi_describe_fields on this tool to see them all.`,
    );
  }

  return {
    target: { tool: target.name, method: target.method, path: target.path, safety: target.safety },
    stepCount: steps.length,
    steps,
    unresolvedParameters: unresolved,
    notes,
    // The string this entire phase exists to be able to stop saying — but only
    // when it is actually untrue. An API with no executed runs still gets the
    // honest spec-only answer, because that is what it is.
    derivedFrom: verification.any()
      ? `spec structure, with ${verification.observedCount()} link(s) confirmed by read-only execution against the live API — see the "verified" field on each producer`
      : 'spec structure only — no live traffic was observed to build this plan',
  };
}
