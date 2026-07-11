// Hand-rolled cURL parser for the paste-a-curl import path. Covers the flags
// people actually paste from API docs; anything else fails loudly with the
// offending flag named (a clear 422 beats a silent misparse).

export class CurlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurlParseError';
  }
}

type ParsedCurl = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  bodyIsForm: boolean;
  basicAuth?: string; // user:pass from -u
};

// Shell-aware tokenizer: single/double quotes, backslash escapes,
// line-continuation backslashes, $'...' ANSI-C quoting (common in copies).
export function tokenize(input: string): string[] {
  const src = input.replace(/\\\r?\n/g, ' ');
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    let token = '';
    while (i < src.length && !/\s/.test(src[i])) {
      const ch = src[i];
      if (ch === "'") {
        const isAnsiC = token === '$';
        if (isAnsiC) token = '';
        i++;
        while (i < src.length && src[i] !== "'") {
          if (isAnsiC && src[i] === '\\' && i + 1 < src.length) {
            const esc = src[++i];
            token += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          } else {
            token += src[i];
          }
          i++;
        }
        if (i >= src.length) throw new CurlParseError('Unterminated single quote');
        i++;
      } else if (ch === '"') {
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\' && i + 1 < src.length && /["\\$`]/.test(src[i + 1])) i++;
          token += src[i++];
        }
        if (i >= src.length) throw new CurlParseError('Unterminated double quote');
        i++;
      } else if (ch === '\\' && i + 1 < src.length) {
        token += src[i + 1];
        i += 2;
      } else {
        token += ch;
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

const IGNORED_FLAGS = new Set([
  '-s', '--silent', '-S', '--show-error', '-v', '--verbose', '-i', '--include',
  '-k', '--insecure', '-L', '--location', '--compressed', '-g', '--globoff',
  '--no-progress-meter', '-f', '--fail',
]);

export function parseCurl(command: string): ParsedCurl {
  const tokens = tokenize(command.trim());
  if (tokens[0]?.toLowerCase() !== 'curl') throw new CurlParseError('Not a cURL command');

  let url: string | undefined;
  let method: string | undefined;
  let isGet = false;
  const headers: Record<string, string> = {};
  const dataParts: string[] = [];
  const urlencodeParts: string[] = [];
  let bodyIsForm = false;
  let basicAuth: string | undefined;

  const next = (flag: string, idx: number): string => {
    const v = tokens[idx];
    if (v === undefined) throw new CurlParseError(`Missing value for ${flag}`);
    return v;
  };

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-X' || t === '--request') method = next(t, ++i).toUpperCase();
    else if (t === '-H' || t === '--header') {
      const raw = next(t, ++i);
      const sep = raw.indexOf(':');
      if (sep > 0) headers[raw.slice(0, sep).trim()] = raw.slice(sep + 1).trim();
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii') {
      let v = next(t, ++i);
      if (v.startsWith('@')) throw new CurlParseError(`File uploads (${t} @file) are not supported`);
      if (t === '--data-raw' && v.startsWith('$')) v = v.slice(1);
      dataParts.push(v);
    } else if (t === '--data-urlencode') {
      urlencodeParts.push(next(t, ++i));
    } else if (t === '-F' || t === '--form') {
      bodyIsForm = true;
      dataParts.push(next(t, ++i));
    } else if (t === '-u' || t === '--user') {
      basicAuth = next(t, ++i);
    } else if (t === '-G' || t === '--get') {
      isGet = true;
    } else if (t === '--url') {
      url = next(t, ++i);
    } else if (t === '-b' || t === '--cookie') {
      ++i; // cookies deliberately dropped — never proxied
    } else if (t === '-o' || t === '--output' || t === '-A' || t === '--user-agent' || t === '-e' || t === '--referer' || t === '-m' || t === '--max-time' || t === '--connect-timeout' || t === '--retry') {
      ++i; // flag with value, irrelevant to the request shape
    } else if (IGNORED_FLAGS.has(t)) {
      // no-op
    } else if (t.startsWith('-') && t !== '-') {
      throw new CurlParseError(`Unsupported cURL flag: ${t}`);
    } else if (!url) {
      url = t;
    } else {
      throw new CurlParseError(`Unexpected argument: ${t}`);
    }
  }

  if (!url) throw new CurlParseError('No URL found in cURL command');
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    throw new CurlParseError(`Invalid URL: ${url}`);
  }

  let body: string | undefined;
  if (isGet) {
    for (const part of [...dataParts, ...urlencodeParts]) {
      const eq = part.indexOf('=');
      if (eq > 0) parsed.searchParams.append(part.slice(0, eq), part.slice(eq + 1));
    }
  } else if (dataParts.length || urlencodeParts.length) {
    body = [...dataParts, ...urlencodeParts.map((p) => {
      const eq = p.indexOf('=');
      return eq > 0 ? `${p.slice(0, eq)}=${encodeURIComponent(p.slice(eq + 1))}` : encodeURIComponent(p);
    })].join('&');
  }

  return {
    url: parsed,
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
    bodyIsForm,
    basicAuth,
  };
}

// Folds a parsed cURL command into a minimal synthetic OAS 3 document so the
// single normalizer handles all import sources.
export function curlToOpenApi(command: string): Record<string, unknown> {
  const req = parseCurl(command);

  const parameters: Array<Record<string, unknown>> = [];
  for (const [key, value] of req.url.searchParams.entries()) {
    parameters.push({
      name: key,
      in: 'query',
      required: false,
      schema: { type: 'string', example: value },
      example: value,
    });
  }

  const securitySchemes: Record<string, unknown> = {};
  const security: Array<Record<string, string[]>> = [];
  const headerParams: Array<Record<string, unknown>> = [];
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'content-type' || lower === 'accept' || lower === 'cookie') continue;
    if (lower === 'authorization') {
      const scheme = value.toLowerCase().startsWith('basic') ? 'basic' : 'bearer';
      securitySchemes.detected = { type: 'http', scheme };
      security.push({ detected: [] });
      continue;
    }
    if (/^(x-)?api[-_]?key$|^x-auth/i.test(name)) {
      securitySchemes.detected = { type: 'apiKey', in: 'header', name };
      security.push({ detected: [] });
      continue;
    }
    headerParams.push({ name, in: 'header', required: false, schema: { type: 'string', example: value }, example: value });
  }
  if (req.basicAuth) {
    securitySchemes.detected = { type: 'http', scheme: 'basic' };
    security.push({ detected: [] });
  }

  const operation: Record<string, unknown> = {
    operationId: `${req.method.toLowerCase()}_${req.url.pathname.split('/').filter(Boolean).join('_') || 'root'}`,
    summary: `${req.method} ${req.url.pathname}`,
    parameters: [...parameters, ...headerParams],
    responses: { '200': { description: 'OK' } },
    ...(security.length ? { security } : {}),
  };

  if (req.body !== undefined && !req.bodyIsForm) {
    let schema: Record<string, unknown> = { type: 'string', example: req.body };
    let contentType = req.headers['Content-Type'] ?? req.headers['content-type'] ?? 'text/plain';
    try {
      const json = JSON.parse(req.body);
      schema = inferSchema(json);
      contentType = 'application/json';
    } catch {
      if (req.body.includes('=') && !contentType.includes('json')) {
        contentType = 'application/x-www-form-urlencoded';
      }
    }
    operation.requestBody = { required: true, content: { [contentType]: { schema } } };
  }

  return {
    openapi: '3.0.3',
    info: { title: req.url.hostname, version: '0.0.0' },
    servers: [{ url: `${req.url.protocol}//${req.url.host}` }],
    ...(Object.keys(securitySchemes).length ? { components: { securitySchemes } } : {}),
    paths: { [req.url.pathname || '/']: { [req.method.toLowerCase()]: operation } },
  };
}

function inferSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return {};
  if (value === null) return { type: 'string', nullable: true };
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length ? inferSchema(value[0], depth + 1) : {} };
  }
  switch (typeof value) {
    case 'object': {
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        properties[k] = { ...inferSchema(v, depth + 1), example: depth < 2 ? v : undefined };
      }
      return { type: 'object', properties };
    }
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    default:
      return { type: 'string' };
  }
}
