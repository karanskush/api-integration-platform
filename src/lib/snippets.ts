import type { Action, AuthPlacement, ImportRecord } from './ir';

// Generates copy-paste snippets per action. Placeholder values come from the
// schema's examples/defaults where available.

type SchemaProp = Record<string, unknown>;

function sampleValue(name: string, schema: SchemaProp): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, SchemaProp>;
      const out: Record<string, unknown> = {};
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : Object.keys(props).slice(0, 3);
      for (const key of required) if (props[key]) out[key] = sampleValue(key, props[key]);
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
    const where = schema['x-spotcheck-in'];
    const value = sampleValue(name, schema);
    if (where === 'path') path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
    else if (where === 'query') query.push([name, String(value)]);
    else if (where === 'header') headers.push([name, String(value)]);
    else if (where === 'body') {
      body = value;
      // Emitting Content-Type: application/json for a body the operation
      // declares as octet-stream or multipart produces a snippet that fails
      // against the real API. normalize.ts records the declared type.
      bodyContentType = String(schema['x-spotcheck-content-type'] ?? 'application/json');
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
