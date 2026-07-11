import type { Action, AuthPlacement } from './ir';

// Builds the upstream HTTP request from a stored Action + validated args.
// Shared by the playground proxy and MCP tools/call — the client never
// controls the URL, only the parameter values.

export type UpstreamAuth = { token?: string };

export type UpstreamRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

export class UpstreamBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamBuildError';
  }
}

export function buildUpstreamRequest(
  action: Action,
  args: Record<string, unknown>,
  auth: UpstreamAuth,
  baseUrl: string,
  authIn?: AuthPlacement,
): UpstreamRequest {
  const props = (action.paramsSchema.properties ?? {}) as Record<string, Record<string, unknown>>;

  let path = action.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {
    accept: 'application/json, */*',
    'user-agent': 'spotcheck-playground/0.1',
  };
  let body: string | undefined;

  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    const where = props[name]?.['x-spotcheck-in'] ?? 'query';
    switch (where) {
      case 'path':
        path = path.split(`{${name}}`).join(encodeURIComponent(String(value)));
        break;
      case 'query':
        query.set(name, String(value));
        break;
      case 'header': {
        // defense in depth: schema building already excludes these
        if (/^(authorization|cookie|host|content-length)$/i.test(name)) break;
        headers[name] = String(value).replace(/[\r\n]/g, '');
        break;
      }
      case 'body':
        body = typeof value === 'string' ? value : JSON.stringify(value);
        headers['content-type'] = 'application/json';
        break;
    }
  }

  const unresolved = path.match(/\{([^}]+)\}/);
  if (unresolved) throw new UpstreamBuildError(`Missing required path parameter: ${unresolved[1]}`);

  // BYOK auth injection — placement comes from the stored action, never the caller
  const token = auth.token?.trim();
  if (token) {
    const placement = authIn ?? action.authIn;
    switch (action.auth) {
      case 'apiKey':
        if (placement?.in === 'query') query.set(placement.name, token);
        else headers[placement?.name ?? 'X-Api-Key'] = token.replace(/[\r\n]/g, '');
        break;
      case 'basic':
        headers.authorization = `Basic ${Buffer.from(token, 'utf8').toString('base64')}`;
        break;
      case 'none':
      case 'bearer':
      case 'oauth2':
      default:
        headers.authorization = `Bearer ${token.replace(/[\r\n]/g, '')}`;
        break;
    }
  }

  const qs = query.toString();
  const url = `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}${qs ? `?${qs}` : ''}`;
  return { url, method: action.method, headers, body };
}
