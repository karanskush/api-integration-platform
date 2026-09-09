// docentapi_get_webhooks — the events this API emits.
//
// The one part of a contract that describes traffic in the other direction.
// A provider's own developers know which events arrive, how they are
// delivered and what the payload carries; an integrator learned it from prose,
// and an agent could not learn it at all, because neither OpenAPI 3.1
// `webhooks` nor 3.0 `callbacks` was parsed.
//
// HONESTY: these are declared, not observed. No delivery has been received or
// replayed, and the payload says so.

import type { Webhook } from '../ir';
import { asData, type AdvisorContext } from './types';

const MAX_LIST = 50;
const MAX_FIELDS = 40;
// A payload schema past this serialized size is summarized to its top-level
// fields rather than echoed; a deeply nested one could swamp the caller's
// context on its own (LLM10), the same cap get_endpoint_schema applies.
const MAX_SCHEMA_CHARS = 12_000;

const BASIS = 'declared in the spec — no delivery was observed';

export type GetWebhooksArgs = { name?: unknown };

type FieldRow = { name: string; type: string; required: boolean };

function topLevelFields(schema: Webhook['payloadSchema']): FieldRow[] {
  const props = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props || typeof props !== 'object') return [];
  const required = new Set(Array.isArray(schema?.required) ? (schema!.required as unknown[]) : []);
  return Object.entries(props)
    .slice(0, MAX_FIELDS)
    .map(([name, p]) => ({
      name: asData(name, 80),
      type: typeof p?.type === 'string' ? p.type : Array.isArray(p?.type) ? p.type.join('|') : 'unknown',
      required: required.has(name),
    }));
}

function summarize(h: Webhook) {
  return {
    name: asData(h.name, 120),
    method: h.method,
    description: asData(h.description, 300),
    declaredAs: h.source === 'callback' ? 'callback' : 'webhook',
    ...(h.callbackOf ? { registeredBy: h.callbackOf } : {}),
    payloadFields: topLevelFields(h.payloadSchema),
  };
}

export function getWebhooks(ctx: AdvisorContext, args: GetWebhooksArgs) {
  const hooks = ctx.record.webhooks ?? [];
  if (!hooks.length) {
    return {
      count: 0,
      webhooks: [],
      basis: BASIS,
      note: 'This spec declares no webhooks (OpenAPI 3.1 `webhooks`) and no callbacks (OpenAPI 3.0 `callbacks`). The API may still emit events it does not document.',
    };
  }

  const wanted = typeof args.name === 'string' ? args.name.trim() : '';
  if (wanted) {
    const found = hooks.find((h) => h.name === wanted);
    if (!found) {
      return {
        error: `No webhook named "${asData(wanted, 80)}" is declared on this API.`,
        hint: 'Call docentapi_get_webhooks with no arguments to list them.',
      };
    }
    const serialized = found.payloadSchema ? JSON.stringify(found.payloadSchema) : '';
    return {
      ...summarize(found),
      payloadSchema:
        found.payloadSchema && serialized.length <= MAX_SCHEMA_CHARS
          ? found.payloadSchema
          : found.payloadSchema
            ? { truncated: true, note: 'Payload schema too large to echo; payloadFields lists its top level.' }
            : null,
      basis: BASIS,
    };
  }

  return {
    count: hooks.length,
    webhooks: hooks.slice(0, MAX_LIST).map(summarize),
    ...(hooks.length > MAX_LIST ? { truncated: true } : {}),
    basis: BASIS,
    note: '"webhook" is an event the API sends to a URL you configure out of band; "callback" is one registered per request by the operation named in registeredBy. Call with a name for the full payload schema.',
  };
}
