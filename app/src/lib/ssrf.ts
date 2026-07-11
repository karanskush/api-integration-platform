// SSRF-guarded outbound fetch, used for EVERY upstream request: spec fetches,
// playground proxy calls, and MCP tools/call. See TECH_IMPLEMENTATION.md §5.
//
// Defense layers:
//   1. static URL checks (protocol, userinfo, obvious internal hostnames)
//   2. DNS pre-resolution — every address must be public
//   3. IP pinning via a custom undici Agent lookup, so the socket can only
//      connect to the already-validated addresses (closes DNS-rebind TOCTOU)
//   4. manual redirect loop, same-host only, ≤3 hops, re-validated per hop
//   5. time and size caps, streamed with an aborting counter

import { lookup as dnsLookup } from 'node:dns';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

const lookupAsync = promisify(dnsLookup);

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

const BLOCKED_V4: Array<[number, number]> = [
  // [network, prefix]
  [ipv4ToInt('0.0.0.0'), 8],
  [ipv4ToInt('10.0.0.0'), 8],
  [ipv4ToInt('100.64.0.0'), 10], // CGNAT
  [ipv4ToInt('127.0.0.0'), 8],
  [ipv4ToInt('169.254.0.0'), 16], // link-local / cloud metadata
  [ipv4ToInt('172.16.0.0'), 12],
  [ipv4ToInt('192.0.0.0'), 24],
  [ipv4ToInt('192.168.0.0'), 16],
  [ipv4ToInt('198.18.0.0'), 15],
  [ipv4ToInt('224.0.0.0'), 4], // multicast
  [ipv4ToInt('240.0.0.0'), 4], // reserved + broadcast
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function isPublicIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return !BLOCKED_V4.some(([net, prefix]) => (n >>> (32 - prefix)) === (net >>> (32 - prefix)));
}

export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicIpv4(ip);
  if (family !== 6) return false;

  const lower = ip.toLowerCase();
  // IPv4-mapped / IPv4-translated — re-check the embedded v4
  const mapped = lower.match(/^::(?:ffff(?::0)?:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpv4(mapped[1]);

  const groups = expandIpv6(lower);
  if (!groups) return false;
  const first = groups[0];

  if (groups.every((g) => g === 0)) return false; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false; // ::1
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (first === 0x2001 && groups[1] === 0xdb8) return false; // documentation
  if (first === 0x0064 && groups[1] === 0xff9b) {
    // 64:ff9b::/96 NAT64 — embedded IPv4 in the last two groups
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPublicIpv4(v4);
  }
  return true;
}

function expandIpv6(ip: string): number[] | null {
  // strip zone index
  const bare = ip.split('%')[0];
  const parts = bare.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  // embedded IPv4 tail (e.g. ::ffff:1.2.3.4) handled by caller regex; reject here
  if ([...head, ...tail].some((g) => g.includes('.'))) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (parts.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g || '0', 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

const BLOCKED_HOSTNAMES = /^(localhost|.*\.local|.*\.localhost|.*\.internal|.*\.home\.arpa|metadata\.google\.internal)$/i;

// Validates the URL statically + resolves and validates every address.
// Returns the validated addresses for pinning.
export async function assertPublicUrl(rawUrl: string): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Unsupported protocol: ${url.protocol}`);
  }
  if (url.username || url.password) throw new SsrfError('URLs with credentials are not allowed');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.test(host)) throw new SsrfError(`Blocked hostname: ${host}`);

  if (isIP(host)) {
    if (!isPublicIp(host)) throw new SsrfError(`Blocked IP address: ${host}`);
    return { url, addresses: [host] };
  }

  let records: Array<{ address: string }>;
  try {
    records = (await lookupAsync(host, { all: true, verbatim: true })) as Array<{ address: string }>;
  } catch {
    throw new UpstreamError(`Could not resolve host: ${host}`);
  }
  if (!records.length) throw new UpstreamError(`Could not resolve host: ${host}`);
  for (const r of records) {
    if (!isPublicIp(r.address)) {
      throw new SsrfError(`Host ${host} resolves to a blocked address`);
    }
  }
  return { url, addresses: records.map((r) => r.address) };
}

function pinnedAgent(hostname: string, addresses: string[]): Agent {
  const pinned = addresses.map((address) => ({ address, family: isIP(address) as 4 | 6 }));
  return new Agent({
    connect: {
      lookup: (host, _opts, cb) => {
        if (host !== hostname) {
          cb(new Error(`Unexpected host ${host}`), []);
          return;
        }
        cb(null, pinned);
      },
    },
  });
}

export type SafeFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number; // default 10s
  maxBytes?: number; // default 5MB
  maxRedirects?: number; // default 3, same-host only
};

export type SafeFetchResult = {
  status: number;
  headers: Headers;
  body: Uint8Array;
  finalUrl: string;
  latencyMs: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? 3;
  const started = Date.now();
  const deadline = started + timeoutMs;

  let current = rawUrl;
  let hops = 0;

  for (;;) {
    const { url, addresses } = await assertPublicUrl(current);
    const agent = pinnedAgent(url.hostname.replace(/^\[|\]$/g, ''), addresses);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new UpstreamError('Upstream request timed out');

    let res;
    try {
      res = await undiciFetch(url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body,
        dispatcher: agent,
        redirect: 'manual',
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err) {
      throw new UpstreamError(
        `Upstream request failed: ${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : 'unknown error'}`,
      );
    }

    if (res.status >= 301 && res.status <= 308 && res.headers.get('location')) {
      res.body?.cancel().catch(() => {});
      if (++hops > maxRedirects) throw new UpstreamError('Too many redirects');
      const next = new URL(res.headers.get('location')!, url);
      if (next.host !== url.host) {
        throw new SsrfError('Cross-host redirects are not allowed');
      }
      current = next.toString();
      continue;
    }

    // Stream with a byte cap
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      res.body?.cancel().catch(() => {});
      throw new UpstreamError(`Response too large (>${maxBytes} bytes)`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new UpstreamError(`Response too large (>${maxBytes} bytes)`);
        }
        chunks.push(value);
        if (Date.now() > deadline) {
          await reader.cancel().catch(() => {});
          throw new UpstreamError('Upstream request timed out');
        }
      }
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.byteLength;
    }

    const headers = new Headers();
    res.headers.forEach((v, k) => {
      if (k.toLowerCase() !== 'set-cookie') headers.set(k, v);
    });

    return {
      status: res.status,
      headers,
      body,
      finalUrl: url.toString(),
      latencyMs: Date.now() - started,
    };
  }
}
