// Detects how a list operation paginates.
//
// This is the question an agent hits immediately after "what can I send" and
// "where does this id come from": it calls a list endpoint, gets 20 of 4,000
// rows back, and has to work out how to ask for the rest. Specs almost never
// say so in prose, but the shape is right there in the parameter and response
// field names — which is exactly the kind of derivation this codebase already
// does elsewhere (ID_LIKE in advisor/sequence.ts, IDEMPOTENCY_PARAM in
// probes/idempotency.ts).
//
// Pure, like fieldMap.ts and lineage.ts. Reports `none` rather than guessing
// when nothing matches: claiming an endpoint is cursor-paginated when it isn't
// sends an agent into a loop that never terminates.

import { fieldMapFor, type FieldMap, type FieldNode } from './fieldMap';
import type { Action } from './ir';
import { normalizeFieldName } from './resource';

export type PaginationModel = 'cursor' | 'page' | 'offset' | 'none';

export type PaginationInfo = {
  model: PaginationModel;
  // Request parameters that drive it.
  cursorParam?: string;
  pageParam?: string;
  offsetParam?: string;
  sizeParam?: string;
  // Response fields that report position.
  nextField?: string;
  hasMoreField?: string;
  totalField?: string;
  confidence: 'high' | 'medium';
  note: string;
};

// Matched against normalized (snake_case) names, so `pageToken`, `page_token`
// and `PageToken` all land the same way.
const CURSOR_PARAMS = new Set([
  'cursor', 'after', 'before', 'page_token', 'next_token', 'continuation_token',
  'starting_after', 'ending_before', 'next_cursor', 'from', 'since_id', 'max_id',
]);
const PAGE_PARAMS = new Set(['page', 'page_number', 'page_num', 'p']);
const OFFSET_PARAMS = new Set(['offset', 'skip', 'start', 'start_index', 'start_at']);
const SIZE_PARAMS = new Set([
  'limit', 'per_page', 'page_size', 'count', 'max_results', 'size', 'top', 'first', 'take', 'results_per_page',
]);

const NEXT_FIELDS = new Set([
  'next', 'next_page', 'next_cursor', 'next_token', 'next_page_token', 'next_url', 'next_href',
  'continuation_token', 'after', 'end_cursor',
]);
const HAS_MORE_FIELDS = new Set(['has_more', 'has_next', 'has_next_page', 'more', 'is_last_page', 'last_page']);
const TOTAL_FIELDS = new Set(['total', 'total_count', 'total_results', 'total_items', 'count', 'total_pages', 'page_count']);

function findRequest(map: FieldMap, names: Set<string>): FieldNode | undefined {
  return map.request.find((f) => (f.location === 'query' || f.location === 'header') && names.has(normalizeFieldName(f.name)));
}

// Response fields can sit at any depth — `meta.next_cursor`, `links.next`,
// `pagination.has_more` are all common envelope shapes.
function findResponse(map: FieldMap, names: Set<string>): FieldNode | undefined {
  return map.response.find((f) => !f.container && names.has(normalizeFieldName(f.name)));
}

export function paginationFor(action: Action, precomputed?: FieldMap): PaginationInfo {
  // Only reads paginate. A POST that happens to take a `limit` is not a page.
  if (action.method !== 'GET' && action.method !== 'HEAD') {
    return { model: 'none', confidence: 'high', note: 'Not a read operation.' };
  }

  const map = precomputed ?? fieldMapFor(action);

  const cursorParam = findRequest(map, CURSOR_PARAMS);
  const pageParam = findRequest(map, PAGE_PARAMS);
  const offsetParam = findRequest(map, OFFSET_PARAMS);
  const sizeParam = findRequest(map, SIZE_PARAMS);

  const nextField = findResponse(map, NEXT_FIELDS);
  const hasMoreField = findResponse(map, HAS_MORE_FIELDS);
  const totalField = findResponse(map, TOTAL_FIELDS);

  const common = {
    ...(cursorParam ? { cursorParam: cursorParam.name } : {}),
    ...(pageParam ? { pageParam: pageParam.name } : {}),
    ...(offsetParam ? { offsetParam: offsetParam.name } : {}),
    ...(sizeParam ? { sizeParam: sizeParam.name } : {}),
    ...(nextField ? { nextField: nextField.path } : {}),
    ...(hasMoreField ? { hasMoreField: hasMoreField.path } : {}),
    ...(totalField ? { totalField: totalField.path } : {}),
  };

  // Cursor first: when an API offers both a cursor and a page number, the
  // cursor is the one that stays correct while the underlying data changes.
  if (cursorParam) {
    return {
      model: 'cursor',
      ...common,
      confidence: nextField || hasMoreField ? 'high' : 'medium',
      note: nextField
        ? `Cursor-paginated. Pass "${cursorParam.name}" and read the next cursor from "${nextField.path}". Stop when it is absent or empty.`
        : `Cursor-paginated on "${cursorParam.name}". The spec documents no next-cursor response field, so read it from the body at runtime and stop when it is absent.`,
    };
  }

  if (pageParam) {
    return {
      model: 'page',
      ...common,
      confidence: totalField || hasMoreField ? 'high' : 'medium',
      note: `Page-numbered. Increment "${pageParam.name}"${sizeParam ? ` and set "${sizeParam.name}" for page size` : ''}. ${
        totalField ? `Stop using "${totalField.path}".` : 'Stop when a page comes back short or empty.'
      }`,
    };
  }

  if (offsetParam) {
    return {
      model: 'offset',
      ...common,
      confidence: totalField ? 'high' : 'medium',
      note: `Offset-based. Advance "${offsetParam.name}" by ${sizeParam ? `"${sizeParam.name}"` : 'the page size'} each call. ${
        totalField ? `Stop using "${totalField.path}".` : 'Stop when a page comes back short.'
      } Results can shift if rows are inserted mid-scan.`,
    };
  }

  // A next/has_more field with no matching request parameter usually means
  // link-style pagination: follow the returned URL rather than build one.
  if (nextField || hasMoreField) {
    return {
      model: 'cursor',
      ...common,
      confidence: 'medium',
      note: `The response exposes ${nextField ? `"${nextField.path}"` : `"${hasMoreField!.path}"`} but the spec documents no matching request parameter — this is usually a follow-the-link style API. Use the URL or token the response gives you rather than constructing one.`,
    };
  }

  // A size cap with no positioning parameter is a truncation limit, not a page.
  if (sizeParam) {
    return {
      model: 'none',
      ...common,
      confidence: 'medium',
      note: `"${sizeParam.name}" caps the result size, but the spec documents no way to request the next page. Treat the first response as the whole result set.`,
    };
  }

  return { model: 'none', confidence: 'high', note: 'No pagination parameters or response markers are documented.' };
}
