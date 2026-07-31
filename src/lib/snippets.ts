import { mergeCombinators } from './fieldMap';
import type { Action, AuthPlacement, ImportRecord } from './ir';

// Generates copy-paste snippets per action. Placeholder values come from the
// schema's examples/defaults where available.
//
// THE SNIPPET AND THE PARAMETER TABLE MUST AGREE. They are rendered inches
// apart on the same page and read as one claim about the operation, so a field
// the table lists and the snippet omits reads as "this endpoint does not really
// take that". Petstore's PUT /pet is the case that exposed it: the table listed
// category.name, and the body walked only the `required` list, so the snippet
// emitted {"name":"doggie","photoUrls":[]} — dropping category and tags
// entirely, along with every example ("doggie", 10, "Dogs") the spec's own
// author wrote for exactly this purpose.
//
// So the sample is the FULL declared shape, not the minimal valid one:
//   * optional properties are included, not just `required` ones;
//   * arrays carry one sample item built from `items` rather than being `[]`;
//   * allOf/oneOf/anyOf are merged the same way fieldMap.ts merges them for the
//     table, so a composed schema cannot render differently in the two places;
//   * readOnly fields are skipped — the API assigns those, and sending one is
//     wrong regardless of what the table shows.

type SchemaProp = Record<string, unknown>;

// Bounds. Unlike fieldMap.ts these cannot report truncation — there is nowhere
// in a JSON body to say "and 40 more" — so they are set generously enough that
// an ordinary operation is never clipped, and exist only to keep a pathological
// or self-referential schema from producing an unusable wall of JSON.
const MAX_SAMPLE_DEPTH = 6;
const MAX_SAMPLE_PROPS = 24;

function asSchema(value: unknown): SchemaProp | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as SchemaProp) : null;
}

// Mirrors fieldMap.ts typeOf(): a schema with `properties` is an object and one
// with `items` is an array even when it never says so, which is common enough
// in hand-written specs that inferring it is the difference between a real body
// and a "<body>" placeholder.
function typeOf(schema: SchemaProp): string {
  const raw = schema.type;
  const declared = Array.isArray(raw) ? raw.find((t) => typeof t === 'string' && t !== 'null') : raw;
  if (typeof declared === 'string') return declared;
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return 'unknown';
}

// Required first, then the rest in spec order: requiredness is what a reader
// scans for, and it also decides what survives if MAX_SAMPLE_PROPS ever bites.
function orderedKeys(props: Record<string, SchemaProp>, required: Set<string>): string[] {
  const keys = Object.keys(props);
  return [...keys.filter((k) => required.has(k)), ...keys.filter((k) => !required.has(k))];
}

function sampleValue(name: string, raw: SchemaProp, depth = 0): unknown {
  const schema = mergeCombinators(raw);

  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;

  switch (typeOf(schema)) {
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array': {
      const items = asSchema(schema.items);
      if (!items || depth >= MAX_SAMPLE_DEPTH) return [];
      return [sampleValue(name, items, depth + 1)];
    }
    case 'object': {
      const props = asSchema(schema.properties) as Record<string, SchemaProp> | null;
      if (!props || depth >= MAX_SAMPLE_DEPTH) return {};
      const required = new Set(
        Array.isArray(schema.required) ? (schema.required as unknown[]).filter((r): r is string => typeof r === 'string') : [],
      );
      const out: Record<string, unknown> = {};
      for (const key of orderedKeys(props, required).slice(0, MAX_SAMPLE_PROPS)) {
        const child = asSchema(props[key]);
        if (!child || child.readOnly === true) continue;
        out[key] = sampleValue(key, child, depth + 1);
      }
      return out;
    }
    default:
      return `<${name}>`;
  }
}

export type ActionParts = {
  url: string; // with {path} params substituted with sample values
  query: Array<[string, string]>;
  headers: Array<[string, string]>;
  body?: unknown;
};

export function buildSampleParts(action: Action, baseUrl: string, authIn?: AuthPlacement): ActionParts {
  const props = (action.paramsSchema.properties ?? {}) as Record<string, SchemaProp>;
  let path = action.path;
  const query: Array<[string, string]> = [];
  const headers: Array<[string, string]> = [];
  let body: unknown;
  let bodyContentType = 'application/json';

  for (const [name, schema] of Object.entries(props)) {
    const where = schema['x-docentapi-in'];
    const value = sampleValue(name, schema);
    if (where === 'path') path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
    else if (where === 'query') query.push([name, String(value)]);
    else if (where === 'header') headers.push([name, String(value)]);
    else if (where === 'body') {
      body = value;
      // Emitting Content-Type: application/json for a body the operation
      // declares as octet-stream or multipart produces a snippet that fails
      // against the real API. normalize.ts records the declared type.
      bodyContentType = String(schema['x-docentapi-content-type'] ?? 'application/json');
    }
  }

  switch (action.auth) {
    case 'bearer':
    case 'oauth2':
      headers.unshift(['Authorization', 'Bearer $API_KEY']);
      break;
    case 'basic':
      headers.unshift(['Authorization', 'Basic $BASE64_CREDENTIALS']);
      break;
    case 'apiKey':
      if (authIn?.in === 'query') query.unshift([authIn.name, '$API_KEY']);
      else headers.unshift([authIn?.name ?? 'X-Api-Key', '$API_KEY']);
      break;
  }

  if (body !== undefined) headers.push(['Content-Type', bodyContentType]);

  const qs = query.length ? `?${query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : '';
  return { url: `${baseUrl}${path}${qs}`, query, headers, body };
}

export function curlSnippet(action: Action, record: ImportRecord): string {
  const base = record.baseUrls[0] ?? 'https://api.example.com';
  const parts = buildSampleParts(action, base, record.authIn ?? action.authIn);
  const lines = [`curl -X ${action.method} '${parts.url}'`];
  for (const [k, v] of parts.headers) lines.push(`  -H '${k}: ${v}'`);
  if (parts.body !== undefined) lines.push(`  -d '${JSON.stringify(parts.body)}'`);
  return lines.join(' \\\n');
}

// Header values containing the $API_KEY placeholder are emitted as JS
// template literals / Python f-strings referencing the apiKey variable.
export function tsSnippet(action: Action, record: ImportRecord): string {
  const base = record.baseUrls[0] ?? 'https://api.example.com';
  const parts = buildSampleParts(action, base, record.authIn ?? action.authIn);
  const headerLines = parts.headers.map(([k, v]) =>
    v.includes('$API_KEY')
      ? `    ${JSON.stringify(k)}: \`${v.replace('$API_KEY', '${apiKey}')}\`,`
      : `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`,
  );
  return [
    `const apiKey = process.env.API_KEY!;`,
    ``,
    `const res = await fetch(${JSON.stringify(parts.url)}, {`,
    `  method: ${JSON.stringify(action.method)},`,
    ...(headerLines.length ? [`  headers: {`, ...headerLines, `  },`] : []),
    ...(parts.body !== undefined
      ? [`  body: JSON.stringify(${JSON.stringify(parts.body, null, 2).replace(/\n/g, '\n  ')}),`]
      : []),
    `});`,
    `const data = await res.json();`,
  ].join('\n');
}

export function pythonSnippet(action: Action, record: ImportRecord): string {
  const base = record.baseUrls[0] ?? 'https://api.example.com';
  const parts = buildSampleParts(action, base, record.authIn ?? action.authIn);
  const headerLines = parts.headers.map(([k, v]) =>
    v.includes('$API_KEY')
      ? `        ${JSON.stringify(k)}: f${JSON.stringify(v.replace('$API_KEY', '{api_key}'))},`
      : `        ${JSON.stringify(k)}: ${JSON.stringify(v)},`,
  );
  return [
    `import os, requests`,
    ``,
    `api_key = os.environ["API_KEY"]`,
    `res = requests.request(`,
    `    ${JSON.stringify(action.method)},`,
    `    ${JSON.stringify(parts.url)},`,
    ...(headerLines.length ? [`    headers={`, ...headerLines, `    },`] : []),
    ...(parts.body !== undefined ? [`    json=${pyLiteral(parts.body)},`] : []),
    `)`,
    `print(res.status_code, res.text)`,
  ].join('\n');
}

function pyLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\btrue\b/g, 'True')
    .replace(/\bfalse\b/g, 'False')
    .replace(/\bnull\b/g, 'None');
}
