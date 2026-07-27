// Builds an OpenAPI-shaped document from Spotcheck's own normalized model of
// the API — NOT a byte-for-byte re-annotation of the customer's original
// file. normalize.ts already restructures $refs/oneOf/allOf away during
// import, so there is no clean 1:1 path back onto the original tree; this is
// assembled fresh from the same Action[] everything else in this codebase
// already treats as the source of truth.
//
// Every field carries x-spotcheck-* extensions: origin, the operation(s) that
// produce it, lineage confidence, and whether a human confirmed it via an
// answered clarification. The x-spotcheck- prefix follows the standard
// vendor-extension convention (Speakeasy's x-speakeasy-, etc.) — any tool
// that doesn't recognise it simply ignores it.
//
// `requestFields` (not `properties`) is a deliberately flat field-path map,
// not a nested JSON Schema `properties` tree — calling it `properties` would
// misrepresent it as spec-compliant nesting it does not attempt to be.

import { fieldMapFor, originOf, type FieldNode } from '../fieldMap';
import type { Action, ImportRecord } from '../ir';
import { lineageFor, producersFor } from '../lineage';

export type HumanVerifiedLookup = (tool: string, field: string) => boolean;

function annotateField(action: Action, field: FieldNode, record: ImportRecord, verified: HumanVerifiedLookup) {
  const graph = lineageFor(record);
  const producers = producersFor(graph, action.name, field.path);
  const origin = originOf(field, producers.length > 0);

  return {
    type: field.nullable ? [field.type, 'null'] : field.type,
    ...(field.format ? { format: field.format } : {}),
    ...(field.enum ? { enum: field.enum } : {}),
    ...(field.description ? { description: field.description } : {}),
    'x-spotcheck-origin': origin,
    ...(producers.length
      ? {
          'x-spotcheck-produced-by': producers.map((p) => ({
            operation: p.from.tool,
            field: p.from.field,
            confidence: p.confidence,
          })),
        }
      : {}),
    'x-spotcheck-human-verified': verified(action.name, field.path),
  };
}

export function buildEnrichedSpec(
  record: ImportRecord,
  humanVerifiedFields: Set<string> = new Set(),
): Record<string, unknown> {
  const verified: HumanVerifiedLookup = (tool, field) => humanVerifiedFields.has(`${tool} ${field}`);
  const paths: Record<string, Record<string, unknown>> = {};

  for (const action of record.actions) {
    const map = fieldMapFor(action);
    const requestFields: Record<string, unknown> = {};
    for (const field of map.request) {
      if (field.container) continue;
      requestFields[field.path] = annotateField(action, field, record, verified);
    }

    const pathEntry = paths[action.path] ?? {};
    pathEntry[action.method.toLowerCase()] = {
      operationId: action.name,
      description: action.description,
      'x-spotcheck-safety': action.safety,
      requestFields,
    };
    paths[action.path] = pathEntry;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${record.name} — Spotcheck-enriched`,
      version: '1.0.0',
      description:
        "Assembled from Spotcheck's normalized model of this API, not a re-annotation of the original file. Every field carries x-spotcheck-* tags describing its origin, known producers, and whether a human confirmed it.",
    },
    paths,
  };
}
