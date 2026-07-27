// The normalized intermediate representation. Everything downstream —
// page renderer, playground proxy, MCP handler, snippets — reads this and
// nothing else. See TECH_IMPLEMENTATION.md §3.

export type JSONSchema = Record<string, unknown>;

export type AuthScheme = 'none' | 'apiKey' | 'bearer' | 'basic' | 'oauth2';

export type Safety = 'read' | 'write' | 'destructive';

export type ParamLocation = 'path' | 'query' | 'header' | 'body';

export type Example = { name?: string; params: Record<string, unknown> };

export type AuthPlacement = { in: 'header' | 'query'; name: string };

export type Action = {
  id: string; // stable within an import: hash(method+path), 8 hex chars
  name: string; // snake_case tool name, unique within the import, ≤64 chars
  description: string; // cleaned, agent-legible, ≤500 chars
  method: string; // GET | POST | ...
  path: string; // /v1/pets/{petId}
  // Object schema. Top-level properties carry 'x-spotcheck-in' annotations
  // (path|query|header); the request body is a single 'body' property.
  paramsSchema: JSONSchema;
  auth: AuthScheme;
  authIn?: AuthPlacement; // apiKey placement (e.g. header X-Api-Key)
  safety: Safety; // gates MCP exposure: destructive never exposed in Phase 0
  examples: Example[];
  responseSchema?: JSONSchema; // documented 2xx application/json schema, if any
  errorSchema?: JSONSchema; // documented 4xx application/json schema, if any
  // OAuth2/OIDC scopes this operation's security requirement declares, e.g.
  // ['write:orders']. Undefined (not empty) when auth isn't oauth2/openIdConnect
  // or the spec's security requirement lists none — that distinguishes "no
  // scope requirement documented" from "documented as requiring nothing".
  scopes?: string[];
};

export type ImportSource = 'openapi' | 'swagger' | 'postman' | 'curl';

export type ImportRecord = {
  id: string; // short public id (page + MCP URL segment)
  name: string; // API title from the spec, or hostname
  source: ImportSource;
  sourceUrl?: string;
  baseUrls: string[]; // SSRF-validated absolute URLs; exact-match allowlist
  auth: AuthScheme; // dominant scheme, drives the auth guide
  authIn?: AuthPlacement;
  actions: Action[];
  truncated?: boolean; // true when the spec exceeded MAX_ACTIONS
  // The spec's own declared externalDocs.url, if any — a seed for the
  // deep-analysis pipeline's docs crawler (docsCrawler.ts). NOT yet
  // SSRF-validated — validated at the point it's actually fetched, since it's
  // only ever consumed by the crawler and never used to construct a request
  // the way baseUrls is.
  externalDocsUrl?: string;
  counts: { total: number; read: number; write: number; destructive: number };
  createdAt: number;
  expiresAt: number;
};

export const MAX_ACTIONS = 300;
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export function ttlSeconds(): number {
  const raw = process.env.SPOTCHECK_TTL_SECONDS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TTL_SECONDS;
}

export function mcpExposedActions(record: ImportRecord): Action[] {
  return record.actions.filter((a) => a.safety !== 'destructive');
}
