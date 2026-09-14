// Which resources a write probe may exercise, and with which operations.
//
// A "family" is the REST shape every write probe needs: a collection POST that
// creates, an item GET that reads back, an item PUT/PATCH that updates, and an
// item DELETE that is the cleanup contract's inverse operation. It is planned
// from the spec alone — path templates plus the lineage graph's knowledge of
// which response field carries the id the item path wants — and every family
// the planner declines gets a typed reason rather than a silent drop.
//
// Pure. The runner decides what to do with the plan; the policy gate decides
// whether it may.

import type { Action, ImportRecord } from '../ir';
import { lineageFor } from '../lineage';
import { collectionPathFor, resourceOf } from '../resource';
import { classifyEffect, type ClassifyOptions, type RiskClass } from './policy';

export type FamilySkip =
  | 'r4_never_probed'
  | 'consequential_token'
  | 'no_delete'
  | 'no_read'
  | 'no_item_path'
  | 'no_body';

export type ResourceFamily = {
  entity: string;
  collectionPath: string;
  create: Action;
  read: Action | null;
  update: Action | null;
  remove: Action | null;
  /** The item path's parameter name, e.g. `petId`. */
  idParam: string | null;
  /** Where the created id may appear in the create response, most likely first. */
  idFieldCandidates: string[];
  risk: RiskClass;
  skip: FamilySkip | null;
};

function itemActionsFor(record: ImportRecord, collectionPath: string): { param: string; actions: Action[] } | null {
  const escaped = collectionPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}/\\{([^}]+)\\}$`);
  let param: string | null = null;
  const actions: Action[] = [];
  for (const action of record.actions) {
    const m = action.path.match(re);
    if (!m) continue;
    if (param && m[1] !== param) continue;
    param = m[1];
    actions.push(action);
  }
  return param ? { param, actions } : null;
}

function hasBody(action: Action): boolean {
  const props = (action.paramsSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(props).some((p) => p?.['x-docentapi-in'] === 'body');
}

export function planResourceFamilies(record: ImportRecord, opts: ClassifyOptions = {}): ResourceFamily[] {
  const graph = lineageFor(record);
  const families: ResourceFamily[] = [];

  for (const create of record.actions) {
    if (create.method.toUpperCase() !== 'POST' || create.path.includes('{')) continue;
    const collectionPath = create.path;
    const entity = resourceOf(collectionPath) ?? collectionPath.split('/').filter(Boolean).pop() ?? 'resource';
    const items = itemActionsFor(record, collectionPath);
    const byMethod = (m: string) => items?.actions.find((a) => a.method.toUpperCase() === m) ?? null;
    const read = byMethod('GET');
    const update = byMethod('PUT') ?? byMethod('PATCH');
    const remove = byMethod('DELETE');
    const idParam = items?.param ?? null;

    // Where does the id come from? The lineage graph first — it already knows
    // "create.response.id feeds get.path.petId" when that edge exists — then the
    // conventional spellings.
    const candidates: string[] = [];
    if (read && idParam) {
      const edges = graph.producersOf.get(read.name)?.get(`path.${idParam}`) ?? [];
      for (const edge of edges) if (edge.from.tool === create.name && !candidates.includes(edge.from.field)) candidates.push(edge.from.field);
    }
    for (const c of ['response.id', `response.${entity}Id`, `response.${entity}_id`, 'response.data.id', `response.${entity}.id`]) {
      if (!candidates.includes(c)) candidates.push(c);
    }

    const classification = classifyEffect(create, opts);
    let skip: FamilySkip | null = null;
    const anyR4 = [create, update, remove].some((a) => a && classifyEffect(a, opts).risk === 'R4');
    if (anyR4) skip = 'r4_never_probed';
    else if (classification.basis === 'path_token' || (update && classifyEffect(update, opts).basis === 'path_token')) skip = 'consequential_token';
    else if (!items) skip = 'no_item_path';
    else if (!remove) skip = 'no_delete';
    else if (!read) skip = 'no_read';
    else if (!hasBody(create)) skip = 'no_body';

    families.push({
      entity,
      collectionPath,
      create,
      read,
      update,
      remove,
      idParam,
      idFieldCandidates: candidates,
      risk: classification.risk,
      skip,
    });
  }

  // Cheapest, safest first: families with fewer moving parts and a read-back.
  return families.sort((a, b) => Number(a.skip !== null) - Number(b.skip !== null) || a.collectionPath.length - b.collectionPath.length);
}

/** The item-path parameter for a family's collection, when the planner could not derive it (kept for callers that only have the path). */
export function collectionOf(action: Action, param: string): string | null {
  return collectionPathFor(action.path, param);
}
