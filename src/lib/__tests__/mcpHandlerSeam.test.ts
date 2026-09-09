// The exact seam the MCP route depends on, driven through the real library.
//
// mcp-handler 2 / SDK v2 changed three things the route touches: handlers are
// keyed on the method string rather than a request schema, the options are one
// object, and the 1.x transport shims are gone. The route itself is a Next.js
// handler with Redis and Postgres behind it, so this exercises the SAME
// low-level registration pattern (McpServer.server.setRequestHandler) with a
// plain web Request, and asserts on the JSON-RPC that comes back. If the
// library changes the contract again, this goes red before production does.

import { describe, expect, it } from 'vitest';
import { createMcpHandler } from 'mcp-handler';

// `as const` on type: the SDK's Tool type wants the literal "object", and a
// plain string literal widens.
const TOOL = {
  name: 'docentapi_search_endpoints',
  description: 'Find operations by intent.',
  inputSchema: { type: 'object' as const, properties: { q: { type: 'string' as const } } },
};

function handler() {
  return createMcpHandler(
    (server) => {
      const low = server.server;
      low.setRequestHandler('tools/list', async () => ({ tools: [TOOL] }));
      low.setRequestHandler('tools/call', async ({ params }) => ({
        content: [{ type: 'text', text: `called ${params.name} with ${JSON.stringify(params.arguments ?? {})}` }],
      }));
    },
    {
      serverInfo: { name: 'docentapi-seam', version: '0.0.0' },
      capabilities: { tools: {} },
      instructions: 'seam test',
      verboseLogs: false,
    },
  );
}

async function rpc(h: ReturnType<typeof createMcpHandler>, body: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await h(
    new Request('http://localhost/mcp/seam', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // Streamable HTTP may frame a single JSON-RPC response as one SSE event.
  const json = text.trimStart().startsWith('{')
    ? JSON.parse(text)
    : JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', json };
}

describe('the low-level handler pattern against mcp-handler 2', () => {
  it('lists tools through a string-keyed handler', async () => {
    const h = handler();
    const init = await rpc(h, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(init.status).toBe(200);
    expect(init.json.result?.serverInfo?.name).toBe('docentapi-seam');

    const listed = await rpc(h, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, {
      'mcp-protocol-version': init.json.result.protocolVersion,
    });
    expect(listed.status).toBe(200);
    expect(listed.json.result.tools.map((t: { name: string }) => t.name)).toEqual(['docentapi_search_endpoints']);
  });

  it('calls a tool and returns content', async () => {
    const h = handler();
    const init = await rpc(h, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    const called = await rpc(
      h,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'docentapi_search_endpoints', arguments: { q: 'pets' } } },
      { 'mcp-protocol-version': init.json.result.protocolVersion },
    );
    expect(called.status).toBe(200);
    expect(called.json.result.content[0].text).toContain('called docentapi_search_endpoints');
    expect(called.json.result.content[0].text).toContain('"q":"pets"');
  });

  // 2.x removed the legacy HTTP+SSE transport outright; the route used to
  // opt out of it with disableSse. Pin that the library answers for us now.
  it('refuses the legacy SSE transport', async () => {
    const res = await handler()(new Request('http://localhost/sse', { method: 'GET', headers: { accept: 'text/event-stream' } }));
    expect([404, 405, 410]).toContain(res.status);
  });
});
