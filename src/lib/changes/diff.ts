// The IR diff engine: what changed between two versions of an API's contract,
// classified by how much it can hurt an existing integrator.
//
// Why over the IR and not over raw OpenAPI: spec-to-spec diffing is a
// commodity (oasdiff, openapi-changes); what DocentAPI can do that they cannot
// is tie a change to the operation an agent calls by name, the field path the
// lineage graph traces, and the MCP tool whose schema it reshapes. Diffing the
// normalized model gives all three for free and works identically for
// Postman and cURL imports.
//
// Severity vocabulary borrows oasdiff's three levels — ERR (definite breaking),
// WARN (potential breaking), INFO (non-breaking) — as breaking / risky /
// additive, plus `cosmetic` for prose-only changes that affect no client.
// The rule that decides most rows is CONTRAVARIANCE: widening what a request
// may contain or narrowing what a response may contain is safe; the reverse
// breaks someone. oasdiff's deprecation workflow is honoured too: removing an
// operation after its declared `x-sunset` has passed is risky, not breaking,
// because the provider announced it and the announcement was recorded.
//
// Pure and synchronous: no I/O, no DB, no clock other than the injected `now`,
// so the same two records always produce the same ChangeSet.

import { fieldMapFor, type FieldNode } from '../fieldMap';
import { mcpExposedActions, type Action, type ImportRecord } from '../ir';
import { buildToolList } from '../toolList';
import { fingerprintTools } from './fingerprint';

export type Severity = 'breaking' | 'risky' | 'additive' | 'cosmetic';

// Ranked: breaking first. Also the display and truncation order.
export const SEVERITIES: readonly Severity[] = ['breaking', 'risky', 'additive', 'cosmetic'];
const RANK: Record<Severity, number> = { breaking: 0, risky: 1, additive: 2, cosmetic: 3 };

export const CHANGE_KINDS = [
  'api.base_url_changed',
  'api.auth_changed',
  'operation.added',
  'operation.removed',
  'operation.renamed',
  'operation.deprecated',
  'operation.sunset_scheduled',
  'operation.auth_changed',
  'operation.safety_changed',
  'operation.scopes_changed',
  'operation.description_changed',
  'field.added',
  'field.removed',
  'field.type_changed',
  'field.required_changed',
  'field.enum_changed',
  'field.nullable_changed',
  'field.deprecated',
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

export type ChangeLocation = 'request' | 'response' | 'error';

export type Change = {
  kind: ChangeKind;
  severity: Severity;
  actionKey?: string;
  tool?: string;
  method?: string;
  path?: string;
  fieldPath?: string;
  location?: ChangeLocation;
  before?: unknown;
  after?: unknown;
  summary: string;
};

export type ChangeSet = {
  changes: Change[];
  // Counted over EVERY change, including ones dropped by the cap — the
  // headline numbers must not shrink because the list was long.
  counts: Record<Severity, number>;
  highest: Severity | null;
  // MCP tool names whose full descriptor fingerprint differs between versions
  // (added, removed, or reshaped), sorted.
  toolsChanged: string[];
  truncated: boolean;
};

// One Stripe-sized re-import can touch thousands of fields; the ledger keeps
// the most severe rows and says it truncated rather than writing a novel.
export const MAX_CHANGES = 500;
const MAX_ENUM_VALUES = 30;

export type DiffOptions = { now?: Date; maxChanges?: number };

export function emptyCounts(): Record<Severity, number> {
  return { breaking: 0, risky: 0, additive: 0, cosmetic: 0 };
}

export function highestSeverity(changes: ReadonlyArray<{ severity: Severity }>): Severity | null {
  let best: Severity | null = null;
  for (const c of changes) if (best === null || RANK[c.severity] < RANK[best]) best = c.severity;
  return best;
}

// ---------------------------------------------------------------------------
// Entry point

export function diffRecords(prev: ImportRecord, next: ImportRecord, opts: DiffOptions = {}): ChangeSet {
  const now = opts.now ?? new Date();
  const maxChanges = opts.maxChanges ?? MAX_CHANGES;
  const out: Change[] = [];

  diffApiLevel(prev, next, out);

  const prevById = new Map(prev.actions.map((a) => [a.id, a]));
  const nextById = new Map(next.actions.map((a) => [a.id, a]));

  for (const [id, before] of prevById) {
    const after = nextById.get(id);
    if (!after) {
      out.push(removedOperation(before, now));
      continue;
    }
    diffOperation(before, after, out);
  }
  for (const [id, after] of nextById) {
    if (!prevById.has(id)) out.push(op('operation.added', 'additive', after, {}));
  }

  out.sort(compareChanges);

  const counts = emptyCounts();
  for (const c of out) counts[c.severity]++;

  return {
    changes: out.slice(0, maxChanges),
    counts,
    highest: highestSeverity(out),
    toolsChanged: toolsChanged(prev, next),
    truncated: out.length > maxChanges,
  };
}

// ---------------------------------------------------------------------------
// API level

function diffApiLevel(prev: ImportRecord, next: ImportRecord, out: Change[]): void {
  const [prevPrimary] = prev.baseUrls;
  const [nextPrimary] = next.baseUrls;
  if (prevPrimary !== nextPrimary) {
    // Every tool call and playground request goes to baseUrls[0]; a different
    // primary means every existing caller is pointed somewhere new.
    const severity: Severity = !nextPrimary ? 'breaking' : !prevPrimary ? 'additive' : 'breaking';
    out.push({
      kind: 'api.base_url_changed',
      severity,
      before: prevPrimary ?? null,
      after: nextPrimary ?? null,
      summary: !nextPrimary
        ? `Primary base URL removed (was ${prevPrimary}) — calls are disabled until one is declared`
        : !prevPrimary
          ? `Primary base URL declared: ${nextPrimary}`
          : `Primary base URL changed from ${prevPrimary} to ${nextPrimary}`,
    });
  }
  const prevSecondary = new Set(prev.baseUrls.slice(1));
  const nextSecondary = new Set(next.baseUrls.slice(1));
  for (const url of nextSecondary) {
    if (!prevSecondary.has(url) && url !== prevPrimary) {
      out.push({ kind: 'api.base_url_changed', severity: 'additive', after: url, summary: `Base URL added: ${url}` });
    }
  }
  for (const url of prevSecondary) {
    if (!nextSecondary.has(url) && url !== nextPrimary) {
      out.push({ kind: 'api.base_url_changed', severity: 'risky', before: url, summary: `Base URL removed: ${url}` });
    }
  }

  if (prev.auth !== next.auth || !sameJson(prev.authIn, next.authIn)) {
    // The dominant scheme drives the auth guide; the per-operation rows below
    // carry the breaking classification for the operations it actually hits.
    out.push({
      kind: 'api.auth_changed',
      severity: 'risky',
      before: describeAuth(prev.auth, prev.authIn),
      after: describeAuth(next.auth, next.authIn),
      summary: `Dominant auth changed from ${describeAuth(prev.auth, prev.authIn)} to ${describeAuth(next.auth, next.authIn)}`,
    });
  }
}

function describeAuth(scheme: string, placement?: { in: string; name: string }): string {
  return placement ? `${scheme} (${placement.in} ${placement.name})` : scheme;
}

// ---------------------------------------------------------------------------
// Operation level

function opLabel(a: Action): string {
  return `${a.method} ${a.path} (${a.name})`;
}

function op(kind: ChangeKind, severity: Severity, a: Action, extra: Partial<Change> & { summary?: string }): Change {
  return {
    kind,
    severity,
    actionKey: a.id,
    tool: a.name,
    method: a.method,
    path: a.path,
    ...extra,
    summary: extra.summary ?? defaultOpSummary(kind, a),
  };
}

function defaultOpSummary(kind: ChangeKind, a: Action): string {
  switch (kind) {
    case 'operation.added':
      return `${opLabel(a)} added`;
    case 'operation.removed':
      return `${opLabel(a)} removed`;
    default:
      return `${opLabel(a)}: ${kind}`;
  }
}

function removedOperation(before: Action, now: Date): Change {
  const sunset = before.sunsetAt ? Date.parse(before.sunsetAt) : NaN;
  const sunsetPassed = Number.isFinite(sunset) && sunset <= now.getTime();
  if (sunsetPassed) {
    return op('operation.removed', 'risky', before, {
      before: { deprecated: before.deprecated ?? false, sunsetAt: before.sunsetAt },
      summary: `${opLabel(before)} removed after its announced sunset (${before.sunsetAt})`,
    });
  }
  const note = before.sunsetAt
    ? ` before its announced sunset (${before.sunsetAt})`
    : before.deprecated
      ? ' while deprecated, with no sunset date announced'
      : ' without a deprecation notice';
  return op('operation.removed', 'breaking', before, {
    before: { deprecated: before.deprecated ?? false, sunsetAt: before.sunsetAt ?? null },
    summary: `${opLabel(before)} removed${note}`,
  });
}

function diffOperation(before: Action, after: Action, out: Change[]): void {
  if (before.name !== after.name) {
    // The tool an agent calls is identified by name; same method+path under a
    // new name means the old tool vanished from tools/list.
    out.push(
      op('operation.renamed', 'breaking', after, {
        before: before.name,
        after: after.name,
        summary: `${after.method} ${after.path}: tool renamed from ${before.name} to ${after.name}`,
      }),
    );
  }

  const wasDeprecated = before.deprecated === true;
  const isDeprecated = after.deprecated === true;
  if (wasDeprecated !== isDeprecated) {
    out.push(
      op('operation.deprecated', isDeprecated ? 'risky' : 'cosmetic', after, {
        before: wasDeprecated,
        after: isDeprecated,
        summary: isDeprecated ? `${opLabel(after)} marked deprecated` : `${opLabel(after)} no longer marked deprecated`,
      }),
    );
  }

  if ((before.sunsetAt ?? null) !== (after.sunsetAt ?? null)) {
    out.push(
      op('operation.sunset_scheduled', after.sunsetAt ? 'risky' : 'cosmetic', after, {
        before: before.sunsetAt ?? null,
        after: after.sunsetAt ?? null,
        summary: after.sunsetAt
          ? before.sunsetAt
            ? `${opLabel(after)} sunset moved from ${before.sunsetAt} to ${after.sunsetAt}`
            : `${opLabel(after)} sunset scheduled for ${after.sunsetAt}`
          : `${opLabel(after)} sunset date withdrawn (was ${before.sunsetAt})`,
      }),
    );
  }

  if (before.auth !== after.auth || !sameJson(before.authIn, after.authIn)) {
    // none→X: every existing unauthenticated caller now fails. X→Y or a moved
    // placement: every existing caller sends the wrong credential. X→none:
    // nobody breaks, but the operation is now open — worth a look, not a page.
    const severity: Severity = after.auth === 'none' ? 'risky' : 'breaking';
    out.push(
      op('operation.auth_changed', severity, after, {
        before: describeAuth(before.auth, before.authIn),
        after: describeAuth(after.auth, after.authIn),
        summary: `${opLabel(after)} auth changed from ${describeAuth(before.auth, before.authIn)} to ${describeAuth(after.auth, after.authIn)}`,
      }),
    );
  }

  if (before.safety !== after.safety) {
    // Becoming destructive removes the tool from tools/list (mcpExposedActions
    // filters it out); ceasing to be destructive adds it back.
    const severity: Severity =
      after.safety === 'destructive' ? 'breaking' : before.safety === 'destructive' ? 'additive' : 'risky';
    out.push(
      op('operation.safety_changed', severity, after, {
        before: before.safety,
        after: after.safety,
        summary: `${opLabel(after)} safety class changed from ${before.safety} to ${after.safety}`,
      }),
    );
  }

  const prevScopes = new Set(before.scopes ?? []);
  const nextScopes = new Set(after.scopes ?? []);
  const addedScopes = [...nextScopes].filter((s) => !prevScopes.has(s)).sort();
  const removedScopes = [...prevScopes].filter((s) => !nextScopes.has(s)).sort();
  if (addedScopes.length || removedScopes.length) {
    // A newly required scope rejects every token minted before it existed.
    out.push(
      op('operation.scopes_changed', addedScopes.length ? 'breaking' : 'additive', after, {
        before: [...prevScopes].sort(),
        after: [...nextScopes].sort(),
        summary: addedScopes.length
          ? `${opLabel(after)} now requires scope${addedScopes.length > 1 ? 's' : ''} ${addedScopes.join(', ')}`
          : `${opLabel(after)} no longer requires scope${removedScopes.length > 1 ? 's' : ''} ${removedScopes.join(', ')}`,
      }),
    );
  }

  if (before.description !== after.description) {
    out.push(op('operation.description_changed', 'cosmetic', after, { summary: `${opLabel(after)} description changed` }));
  }

  const prevMap = fieldMapFor(before);
  const nextMap = fieldMapFor(after);
  diffFields(after, 'request', prevMap.request, nextMap.request, out);
  diffFields(after, 'response', prevMap.response, nextMap.response, out);
}

// ---------------------------------------------------------------------------
// Field level

function field(kind: ChangeKind, severity: Severity, a: Action, location: ChangeLocation, node: FieldNode, extra: Partial<Change>, summary: string): Change {
  return {
    kind,
    severity,
    actionKey: a.id,
    tool: a.name,
    method: a.method,
    path: a.path,
    fieldPath: node.path,
    location,
    ...extra,
    summary,
  };
}

function diffFields(a: Action, location: 'request' | 'response', prevNodes: FieldNode[], nextNodes: FieldNode[], out: Change[]): void {
  const prevByPath = new Map(prevNodes.map((n) => [n.path, n]));
  const nextByPath = new Map(nextNodes.map((n) => [n.path, n]));
  const label = (n: FieldNode) => `${a.name} ${location} field ${n.path}`;

  for (const [path, before] of prevByPath) {
    if (!nextByPath.has(path)) {
      // A request field a client still sends is now unknown (many APIs reject
      // it); a response field a client still reads is now absent. Both break.
      out.push(field('field.removed', 'breaking', a, location, before, { before: before.type }, `${label(before)} removed`));
    }
  }

  for (const [path, after] of nextByPath) {
    const before = prevByPath.get(path);
    if (!before) {
      const severity: Severity = location === 'request' && after.required ? 'breaking' : 'additive';
      out.push(
        field(
          'field.added',
          severity,
          a,
          location,
          after,
          { after: after.type },
          severity === 'breaking' ? `${label(after)} added as REQUIRED` : `${label(after)} added${after.required ? ' (required)' : ''}`,
        ),
      );
      continue;
    }
    diffField(a, location, before, after, out, label(after));
  }
}

function diffField(a: Action, location: 'request' | 'response', before: FieldNode, after: FieldNode, out: Change[], label: string): void {
  if (before.type !== after.type) {
    out.push(
      field('field.type_changed', 'breaking', a, location, after, { before: before.type, after: after.type }, `${label} type changed from ${before.type} to ${after.type}`),
    );
  } else if ((before.format ?? null) !== (after.format ?? null)) {
    // Same JSON type, different format (date→date-time, int32→int64): a
    // stricter parser may reject, a looser one may not — potential, not sure.
    out.push(
      field(
        'field.type_changed',
        'risky',
        a,
        location,
        after,
        { before: { type: before.type, format: before.format ?? null }, after: { type: after.type, format: after.format ?? null } },
        `${label} format changed from ${before.format ?? 'none'} to ${after.format ?? 'none'}`,
      ),
    );
  }

  if (before.required !== after.required) {
    const severity: Severity =
      location === 'request'
        ? after.required
          ? 'breaking' // a request that omits it was valid and now is not
          : 'additive'
        : after.required
          ? 'additive' // a response guarantee that did not exist before
          : 'risky'; // a field a client relied on may now be absent
    out.push(
      field(
        'field.required_changed',
        severity,
        a,
        location,
        after,
        { before: before.required, after: after.required },
        `${label} is ${after.required ? 'now' : 'no longer'} required`,
      ),
    );
  }

  const prevEnum = enumValues(before);
  const nextEnum = enumValues(after);
  if (prevEnum || nextEnum) {
    const prevSet = new Set(prevEnum ?? []);
    const nextSet = new Set(nextEnum ?? []);
    const removed = prevEnum ? [...prevSet].filter((v) => !nextSet.has(v)) : [];
    const added = nextEnum ? [...nextSet].filter((v) => !prevSet.has(v)) : [];
    const introduced = !prevEnum && !!nextEnum; // free-form value became a closed list
    const dropped = !!prevEnum && !nextEnum; // closed list became free-form
    if (removed.length || added.length || introduced || dropped) {
      // Request: a value a client sends may now be rejected (removed/introduced)
      // — breaking; more choices is harmless. Response: a value a client has
      // never seen may now arrive (added) — risky; fewer values is harmless.
      const severity: Severity =
        location === 'request'
          ? removed.length || introduced
            ? 'breaking'
            : 'additive'
          : added.length || dropped
            ? 'risky'
            : 'additive';
      out.push(
        field(
          'field.enum_changed',
          severity,
          a,
          location,
          after,
          { before: capList(prevEnum), after: capList(nextEnum) },
          introduced
            ? `${label} is now restricted to ${capList(nextEnum)?.length ?? 0} enum values`
            : dropped
              ? `${label} is no longer restricted to an enum`
              : `${label} enum changed${added.length ? ` (+${added.length})` : ''}${removed.length ? ` (-${removed.length})` : ''}`,
        ),
      );
    }
  }

  if (before.nullable !== after.nullable) {
    const severity: Severity =
      location === 'request'
        ? after.nullable
          ? 'additive'
          : 'breaking' // a null a client sends is now rejected
        : after.nullable
          ? 'risky' // a null a client never handled may now arrive
          : 'additive';
    out.push(
      field(
        'field.nullable_changed',
        severity,
        a,
        location,
        after,
        { before: before.nullable, after: after.nullable },
        `${label} is ${after.nullable ? 'now' : 'no longer'} nullable`,
      ),
    );
  }

  if ((before.readOnly ?? false) !== (after.readOnly ?? false)) {
    // Request: readOnly means "you must not send this" — a client that did is
    // now wrong. Response: purely descriptive.
    const severity: Severity = location === 'request' ? (after.readOnly ? 'breaking' : 'additive') : 'cosmetic';
    out.push(
      field(
        'field.type_changed',
        severity,
        a,
        location,
        after,
        { before: { readOnly: before.readOnly ?? false }, after: { readOnly: after.readOnly ?? false } },
        `${label} is ${after.readOnly ? 'now' : 'no longer'} read-only`,
      ),
    );
  }

  if ((before.deprecated ?? false) !== (after.deprecated ?? false)) {
    out.push(
      field(
        'field.deprecated',
        after.deprecated ? 'risky' : 'cosmetic',
        a,
        location,
        after,
        { before: before.deprecated ?? false, after: after.deprecated ?? false },
        after.deprecated ? `${label} marked deprecated` : `${label} no longer marked deprecated`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers

function enumValues(node: FieldNode): string[] | null {
  if (!node.enum || !node.enum.length) return null;
  return node.enum.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
}

function capList(values: string[] | null): string[] | null {
  if (!values) return null;
  return values.length > MAX_ENUM_VALUES ? [...values.slice(0, MAX_ENUM_VALUES), `…+${values.length - MAX_ENUM_VALUES}`] : values;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function level(c: Change): number {
  if (c.fieldPath) return 2;
  if (c.actionKey) return 1;
  return 0;
}

function compareChanges(a: Change, b: Change): number {
  return (
    RANK[a.severity] - RANK[b.severity] ||
    level(a) - level(b) ||
    cmp(a.method, b.method) ||
    cmp(a.path, b.path) ||
    cmp(a.fieldPath, b.fieldPath) ||
    cmp(a.kind, b.kind)
  );
}

function cmp(a: string | undefined, b: string | undefined): number {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

function toolsChanged(prev: ImportRecord, next: ImportRecord): string[] {
  const before = fingerprintTools(buildToolList(mcpExposedActions(prev))).perTool;
  const after = fingerprintTools(buildToolList(mcpExposedActions(next))).perTool;
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => before[n] !== after[n]).sort();
}
