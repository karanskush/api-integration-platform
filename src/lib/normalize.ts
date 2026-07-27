import { createHash } from 'node:crypto';
import type { Action, AuthPlacement, AuthScheme, Example, JSONSchema, Safety } from './ir';
import { MAX_ACTIONS } from './ir';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

const DESTRUCTIVE_NAME = /(delete|remove|destroy|purge|cancel)/;

export type NormalizedSpec = {
  name: string;
  rawBaseUrls: string[]; // absolute, but NOT yet SSRF-validated — caller must filter
  auth: AuthScheme;
  authIn?: AuthPlacement;
  actions: Action[];
  truncated: boolean;
};

type OASOperation = Record<string, unknown>;
type SecurityScheme = { type?: string; scheme?: string; in?: string; name?: string };

export function normalizeOpenApi(doc: Record<string, unknown>, sourceUrl?: string): NormalizedSpec {
  const info = (doc.info ?? {}) as Record<string, unknown>;
  const name =
    (typeof info.title === 'string' && info.title.trim()) ||
    (sourceUrl ? new URL(sourceUrl).hostname : 'Imported API');

  const rawBaseUrls = extractBaseUrls(doc, sourceUrl);
  const schemes = extractSecuritySchemes(doc);
  const rootSecurity = doc.security as Array<Record<string, unknown>> | undefined;

  const actions: Action[] = [];
  const usedNames = new Set<string>();
  let truncated = false;

  const paths = (doc.paths ?? {}) as Record<string, unknown>;
  outer: for (const [path, rawItem] of Object.entries(paths)) {
    if (typeof rawItem !== 'object' || rawItem === null) continue;
    const pathItem = rawItem as Record<string, unknown>;
    const pathParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as OASOperation | undefined;
      if (!op || typeof op !== 'object') continue;
      if (actions.length >= MAX_ACTIONS) {
        truncated = true;
        break outer;
      }

      const { auth, authIn } = resolveAuth(op, rootSecurity, schemes);
      const opParams = Array.isArray(op.parameters) ? op.parameters : [];
      const allParams = dedupeParams([...pathParams, ...opParams]);

      const { paramsSchema, examples } = buildParamsSchema(allParams, op, authIn);
      const { responseSchema, errorSchema } = extractResponseSchemas(op);

      const actionName = uniqueName(toolName(op, method, path), usedNames);
      actions.push({
        id: createHash('sha1').update(`${method} ${path}`).digest('hex').slice(0, 8),
        name: actionName,
        description: cleanDescription(op, method, path),
        method: method.toUpperCase(),
        path,
        paramsSchema,
        auth,
        authIn,
        safety: classifySafety(method, actionName, path),
        examples,
        responseSchema,
        errorSchema,
      });
    }
  }

  const { auth, authIn } = dominantAuth(actions);
  return { name: String(name), rawBaseUrls, auth, authIn, actions, truncated };
}

function extractBaseUrls(doc: Record<string, unknown>, sourceUrl?: string): string[] {
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const urls: string[] = [];
  for (const s of servers) {
    if (typeof s !== 'object' || s === null) continue;
    let url = String((s as Record<string, unknown>).url ?? '');
    if (!url) continue;
    // substitute template variables with their defaults, drop if unresolved
    const vars = (s as Record<string, unknown>).variables as
      | Record<string, { default?: unknown }>
      | undefined;
    url = url.replace(/\{([^}]+)\}/g, (_, key) => {
      const def = vars?.[key]?.default;
      return def != null ? String(def) : ` `;
    });
    if (url.includes(' ')) continue;
    try {
      // relative server URLs resolve against the spec's own URL
      const abs = sourceUrl ? new URL(url, sourceUrl) : new URL(url);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') {
        urls.push(abs.toString().replace(/\/$/, ''));
      }
    } catch {
      // not absolute and no sourceUrl to resolve against — drop
    }
  }
  return [...new Set(urls)];
}

function extractSecuritySchemes(doc: Record<string, unknown>): Record<string, SecurityScheme> {
  const components = (doc.components ?? {}) as Record<string, unknown>;
  return (components.securitySchemes ?? {}) as Record<string, SecurityScheme>;
}

function mapScheme(scheme: SecurityScheme): { auth: AuthScheme; authIn?: AuthPlacement } {
  switch (scheme.type) {
    case 'http':
      if (scheme.scheme === 'bearer') return { auth: 'bearer' };
      if (scheme.scheme === 'basic') return { auth: 'basic' };
      return { auth: 'bearer' };
    case 'apiKey':
      if ((scheme.in === 'header' || scheme.in === 'query') && scheme.name) {
        return { auth: 'apiKey', authIn: { in: scheme.in, name: scheme.name } };
      }
      return { auth: 'apiKey' };
    case 'oauth2':
    case 'openIdConnect':
      return { auth: 'oauth2' };
    default:
      return { auth: 'none' };
  }
}

function resolveAuth(
  op: OASOperation,
  rootSecurity: Array<Record<string, unknown>> | undefined,
  schemes: Record<string, SecurityScheme>,
): { auth: AuthScheme; authIn?: AuthPlacement } {
  const security = (Array.isArray(op.security) ? op.security : rootSecurity) ?? [];
  for (const requirement of security) {
    if (typeof requirement !== 'object' || requirement === null) continue;
    for (const schemeName of Object.keys(requirement)) {
      const scheme = schemes[schemeName];
      if (scheme) return mapScheme(scheme);
    }
  }
  return { auth: 'none' };
}

function dominantAuth(actions: Action[]): { auth: AuthScheme; authIn?: AuthPlacement } {
  const counts = new Map<string, { n: number; action: Action }>();
  for (const a of actions) {
    if (a.auth === 'none') continue;
    const key = `${a.auth}:${a.authIn?.in ?? ''}:${a.authIn?.name ?? ''}`;
    const hit = counts.get(key);
    if (hit) hit.n++;
    else counts.set(key, { n: 1, action: a });
  }
  let best: { n: number; action: Action } | null = null;
  for (const v of counts.values()) if (!best || v.n > best.n) best = v;
  return best ? { auth: best.action.auth, authIn: best.action.authIn } : { auth: 'none' };
}

function toolName(op: OASOperation, method: string, path: string): string {
  const opId = typeof op.operationId === 'string' ? op.operationId : '';
  const base = opId ? snakeCase(opId) : `${method}_${pathWords(path)}`;
  return (base || `${method}_root`).slice(0, 64).replace(/_+$/, '');
}

export function snakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function pathWords(path: string): string {
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const m = seg.match(/^\{(.+)\}$/);
      return m ? `by_${snakeCase(m[1])}` : snakeCase(seg);
    })
    .filter(Boolean);
  return parts.join('_');
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let i = 2; used.has(candidate); i++) candidate = `${name}_${i}`;
  used.add(candidate);
  return candidate;
}

function cleanDescription(op: OASOperation, method: string, path: string): string {
  const raw =
    (typeof op.summary === 'string' && op.summary.trim()) ||
    (typeof op.description === 'string' && op.description.trim()) ||
    `${method.toUpperCase()} ${path}`;
  return raw.replace(/\s+/g, ' ').slice(0, 500);
}

export function classifySafety(method: string, name: string, path: string): Safety {
  const m = method.toLowerCase();
  if (m === 'get' || m === 'head' || m === 'options') return 'read';
  if (m === 'delete') return 'destructive';
  if (DESTRUCTIVE_NAME.test(name) || DESTRUCTIVE_NAME.test(path.toLowerCase())) return 'destructive';
  return 'write';
}

type OASParameter = {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
  example?: unknown;
  type?: string; // Swagger 2 leftovers post-conversion shouldn't appear, but be safe
};

function dedupeParams(params: unknown[]): OASParameter[] {
  const seen = new Map<string, OASParameter>();
  for (const p of params) {
    if (typeof p !== 'object' || p === null) continue;
    const param = p as OASParameter;
    if (!param.name || !param.in) continue;
    seen.set(`${param.in}:${param.name}`, param); // op-level overrides path-level
  }
  return [...seen.values()];
}

function buildParamsSchema(
  params: OASParameter[],
  op: OASOperation,
  authIn?: AuthPlacement,
): { paramsSchema: JSONSchema; examples: Example[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const exampleParams: Record<string, unknown> = {};

  for (const p of params) {
    if (p.in !== 'path' && p.in !== 'query' && p.in !== 'header') continue;
    // never expose the auth credential as a regular parameter
    if (authIn && p.in === authIn.in && p.name!.toLowerCase() === authIn.name.toLowerCase()) continue;
    if (p.in === 'header' && /^(authorization|cookie)$/i.test(p.name!)) continue;

    const schema = sanitizeSchema(p.schema ?? (p.type ? { type: p.type } : {}));
    if (p.description && !schema.description) schema.description = p.description.slice(0, 300);
    schema['x-spotcheck-in'] = p.in;
    properties[p.name!] = schema;
    if (p.in === 'path' || p.required) required.push(p.name!);

    const ex = p.example ?? (p.schema as Record<string, unknown> | undefined)?.example;
    if (ex !== undefined) exampleParams[p.name!] = ex;
  }

  const requestBody = op.requestBody as Record<string, unknown> | undefined;
  if (requestBody && typeof requestBody === 'object') {
    const content = (requestBody.content ?? {}) as Record<string, Record<string, unknown>>;
    const media = content['application/json'] ?? Object.values(content)[0];
    if (media) {
      const bodySchema = sanitizeSchema((media.schema as Record<string, unknown>) ?? {});
      bodySchema['x-spotcheck-in'] = 'body';
      if (!bodySchema.description) {
        bodySchema.description = 'JSON request body';
      }
      properties.body = bodySchema;
      if (requestBody.required) required.push('body');

      const bodyExample =
        media.example ??
        (media.examples && typeof media.examples === 'object'
          ? (Object.values(media.examples)[0] as Record<string, unknown> | undefined)?.value
          : undefined) ??
        (media.schema as Record<string, unknown> | undefined)?.example;
      if (bodyExample !== undefined) exampleParams.body = bodyExample;
    }
  }

  const paramsSchema: JSONSchema = {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
  const examples: Example[] = Object.keys(exampleParams).length ? [{ params: exampleParams }] : [];
  return { paramsSchema, examples };
}

// Best-effort — the spec doc is already fully dereferenced upstream (see
// importer/openapi.ts's dereference() call), so no $ref resolution is needed
// here. Missing/unparseable responses just leave both fields undefined.
function extractResponseSchemas(op: OASOperation): { responseSchema?: JSONSchema; errorSchema?: JSONSchema } {
  try {
    const responses = (op.responses ?? {}) as Record<string, unknown>;
    const codes = Object.keys(responses);

    const jsonSchemaFor = (code: string): JSONSchema | undefined => {
      const response = responses[code];
      if (typeof response !== 'object' || response === null) return undefined;
      const content = (response as Record<string, unknown>).content as Record<string, Record<string, unknown>> | undefined;
      const media = content?.['application/json'];
      if (!media || typeof media.schema !== 'object' || media.schema === null) return undefined;
      return sanitizeSchema(media.schema);
    };

    const successCode = codes.find((c) => /^2\d\d$/.test(c));
    const errorCode = codes.includes('400') ? '400' : codes.filter((c) => /^4\d\d$/.test(c)).sort()[0];

    return {
      responseSchema: successCode ? jsonSchemaFor(successCode) : undefined,
      errorSchema: errorCode ? jsonSchemaFor(errorCode) : undefined,
    };
  } catch {
    return {};
  }
}

const SCHEMA_KEEP_KEYS = new Set([
  'type', 'format', 'enum', 'default', 'description', 'example',
  'properties', 'required', 'items', 'additionalProperties',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems',
  'oneOf', 'anyOf', 'allOf', 'nullable', 'const', 'title',
  // Direction and lifecycle annotations. These were previously dropped as
  // "noise", but they answer a question nothing else can: readOnly means the
  // server generates this field and a client must NOT send it, writeOnly means
  // the opposite. Without them, "what data can we send?" cannot be answered
  // from a response-shaped schema at all — every field looks suppliable.
  // Ajv treats all three as annotations, so validation behaviour is unchanged.
  'readOnly', 'writeOnly', 'deprecated',
]);
const MAX_SCHEMA_DEPTH = 12;

// Deep-cleans an OAS schema into portable JSON Schema: drops vendor keys,
// xml/discriminator noise, and any unresolved $ref (replaced with a permissive
// stub so validation still passes).
export function sanitizeSchema(schema: unknown, depth = 0): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || depth > MAX_SCHEMA_DEPTH) return {};
  const src = schema as Record<string, unknown>;
  if (typeof src.$ref === 'string') return { description: 'unresolved reference' };

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (!SCHEMA_KEEP_KEYS.has(key)) continue;
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
        props[pk] = sanitizeSchema(pv, depth + 1);
      }
      out.properties = props;
    } else if (key === 'items') {
      out.items = sanitizeSchema(value, depth + 1);
    } else if (key === 'additionalProperties') {
      out.additionalProperties = typeof value === 'object' ? sanitizeSchema(value, depth + 1) : value;
    } else if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      if (Array.isArray(value)) out[key] = value.map((v) => sanitizeSchema(v, depth + 1));
    } else {
      out[key] = value;
    }
  }
  // OAS 3.0 nullable → JSON Schema type union
  if (out.nullable === true && typeof out.type === 'string') {
    out.type = [out.type, 'null'];
  }
  delete out.nullable;
  return out;
}
