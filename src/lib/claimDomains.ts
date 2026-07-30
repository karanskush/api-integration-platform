// Which domains are allowed to prove ownership of a given API page.
//
// Without this gate the claim flow is an ownership-takeover primitive: the
// claimant picks the domain, so anyone could claim *any* unclaimed page by
// naming a domain they already control and satisfying the DNS/meta check on
// it. Proof of controlling `attacker.example` says nothing about controlling
// the API the page describes, so the domain must come from the API's own
// registered hostnames.
//
// Two acceptance rules, in descending strength:
//
//   1. EXACT host match — the proof lands on a hostname the API itself
//      serves from (`_docentapi-verify.api.stripe.com`). Always allowed and
//      always safe: whoever can publish records on the API's own hostname is
//      as authoritative as it is possible to be, so no public-suffix
//      reasoning is needed.
//   2. PARENT domain match — the proof lands on a parent of an API hostname
//      (claim `example.com` for `api.example.com`). Convenient, because
//      that's where an org's docs site and email live, but only sound when
//      the parent is a domain a single org can actually register. Proving
//      control of `co.uk` or `vercel.app` must never confer ownership of
//      every `*.co.uk` / `*.vercel.app` API, so parents inside a public
//      suffix are rejected.
//
// Rule 2 needs to know where the registrable boundary is. Rather than pull in
// the full Public Suffix List as a dependency, the guard below covers the
// ICANN multi-label ccTLD patterns and the hosting zones an API is plausibly
// served from. A suffix missing from this list only weakens rule 2, and only
// for an attacker who already controls that entire zone (i.e. is the hosting
// provider) — rule 1 stays available and unaffected either way. Swapping in a
// real PSL later is a drop-in replacement for isPublicSuffix().

import { isIP } from 'node:net';

// Zones where the registrable name sits one level below: `example.co.uk` is
// ownable, `co.uk` is not. Rejected only as an exact parent candidate.
const PUBLIC_SUFFIXES = new Set([
  // ICANN multi-label ccTLD patterns
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'geek.nz', 'school.nz',
  'co.za', 'org.za', 'web.za', 'net.za', 'gov.za', 'ac.za',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'gr.jp', 'lg.jp',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.mx', 'org.mx', 'gob.mx', 'com.ar', 'net.ar', 'org.ar', 'gob.ar',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
  'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk', 'idv.hk',
  'com.tw', 'net.tw', 'org.tw', 'gov.tw', 'edu.tw',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr',
  'co.in', 'net.in', 'org.in', 'gov.in', 'edu.in', 'firm.in', 'gen.in', 'ind.in',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl', 'edu.pl',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'in.ua', 'kiev.ua',
  'co.il', 'org.il', 'net.il', 'gov.il', 'ac.il',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'co.th', 'in.th', 'go.th', 'ac.th', 'or.th', 'net.th',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  'com.pe', 'net.pe', 'org.pe', 'gob.pe',
  'co.id', 'or.id', 'go.id', 'ac.id', 'web.id', 'net.id',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa',
  'com.eg', 'net.eg', 'org.eg', 'gov.eg', 'edu.eg',
  'com.ng', 'net.ng', 'org.ng', 'gov.ng', 'edu.ng',
  'co.ke', 'or.ke', 'go.ke', 'ac.ke', 'ne.ke',
  'com.pk', 'net.pk', 'org.pk', 'gov.pk', 'edu.pk',
  'com.bd', 'net.bd', 'org.bd', 'gov.bd', 'edu.bd',
  'com.es', 'org.es', 'gob.es', 'edu.es',
  'gov.it', 'edu.it',
  'com.ru', 'net.ru', 'org.ru', 'gov.ru', 'edu.ru',
  'co.ir', 'ac.ir', 'gov.ir', 'org.ir', 'net.ir',
  'com.ec', 'com.uy', 'com.py', 'com.bo', 'com.do', 'com.gt', 'com.pa',
  'com.ve', 'com.cy', 'com.mt', 'com.gh', 'com.lb', 'com.kw', 'com.qa',
  'com.bh', 'com.om', 'com.jo', 'com.np', 'com.lk', 'com.kh', 'com.mm',
]);

// Provider zones where *nothing at or below the listed name* is registrable
// by a third party. `execute-api.us-east-1.amazonaws.com` is as un-ownable as
// `amazonaws.com`, so these reject the whole subtree as a parent candidate.
const PUBLIC_SUFFIX_ZONES = [
  // PaaS / static hosting
  'vercel.app', 'vercel.sh', 'netlify.app', 'netlify.com', 'github.io', 'githubusercontent.com',
  'gitlab.io', 'pages.dev', 'workers.dev', 'herokuapp.com', 'herokudns.com', 'onrender.com',
  'railway.app', 'up.railway.app', 'fly.dev', 'deno.dev', 'val.run', 'surge.sh', 'now.sh',
  'glitch.me', 'repl.co', 'replit.dev', 'replit.app', 'codesandbox.io', 'stackblitz.io',
  'readthedocs.io', 'readthedocs.org', 'gitbook.io', 'gitbook.com', 'notion.site',
  'webflow.io', 'squarespace.com', 'wixsite.com', 'myshopify.com', 'bigcartel.com',
  'wordpress.com', 'blogspot.com', 'tumblr.com', 'ghost.io', 'substack.com',
  // AWS
  'amazonaws.com', 'awsapprunner.com', 'elasticbeanstalk.com', 'cloudfront.net',
  'amplifyapp.com', 'awsapps.com', 'on.aws',
  // Google Cloud / Firebase
  'appspot.com', 'cloudfunctions.net', 'run.app', 'web.app', 'firebaseapp.com',
  'firebaseio.com', 'googleusercontent.com', 'googleapis.com', 'withgoogle.com',
  // Azure
  'azurewebsites.net', 'azurestaticapps.net', 'azure-api.net', 'azureedge.net',
  'azurecontainerapps.io', 'cloudapp.azure.com', 'cloudapp.net', 'trafficmanager.net',
  'core.windows.net', 'azurefd.net',
  // Other clouds / CDNs / tunnels
  'digitaloceanspaces.com', 'ondigitalocean.app', 'oraclecloud.com', 'aliyuncs.com',
  'fastly.net', 'akamaized.net', 'akamai.net', 'akamaihd.net', 'edgekey.net',
  'cdn77.org', 'bunnycdn.com', 'b-cdn.net', 'jsdelivr.net', 'unpkg.com',
  'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'trycloudflare.com', 'loca.lt',
  'localhost.run', 'serveo.net', 'telebit.io',
  // API gateways / dev platforms
  'apigee.net', 'mashery.com', 'apiary-mock.com', 'apiary.io', 'mockable.io',
  'requestbin.com', 'beeceptor.com', 'mocky.io', 'postman.co', 'getpostman.com',
  'swaggerhub.com', 'stoplight.io', 'redocly.com',
  // Dynamic DNS
  'duckdns.org', 'no-ip.org', 'no-ip.com', 'dyndns.org', 'ddns.net', 'hopto.org',
  'nip.io', 'sslip.io', 'xip.io', 'localtest.me',
];

// True when `domain` sits at or above the registrable boundary — i.e. it is a
// name no single org owns, so proving control of it must not confer ownership
// of anything beneath it.
export function isPublicSuffix(domain: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, '');
  if (!d.includes('.')) return true; // bare TLD: "com", "io", "dev"
  if (PUBLIC_SUFFIXES.has(d)) return true;
  return PUBLIC_SUFFIX_ZONES.some((zone) => d === zone || d.endsWith(`.${zone}`));
}

// Pulls the hostname out of anything that looks like a URL, tolerating the
// scheme-less base URLs specs sometimes declare ("api.example.com/v1").
function hostOf(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || isIP(host)) return null; // an IP literal has no domain to prove
  if (!host.includes('.')) return null; // single-label host: nothing claimable
  return host;
}

// Every hostname this API demonstrably belongs to: its registered base URLs
// plus wherever its spec was fetched from.
export function apiHostnames(input: { baseUrls?: unknown; sourceUrl?: string | null }): string[] {
  const raw: string[] = [];
  if (Array.isArray(input.baseUrls)) {
    for (const u of input.baseUrls) if (typeof u === 'string') raw.push(u);
  }
  if (input.sourceUrl) raw.push(input.sourceUrl);

  const hosts = new Set<string>();
  for (const r of raw) {
    const h = hostOf(r);
    if (h) hosts.add(h);
  }
  return [...hosts];
}

// The domains a claimant may choose from, most specific first: each API
// hostname, plus each of its parents that is actually registrable.
export function claimableDomains(hostnames: string[]): string[] {
  const out = new Set<string>();
  for (const host of hostnames) {
    out.add(host); // rule 1: exact host, always allowed
    const labels = host.split('.');
    // rule 2: parents, stopping before the public-suffix boundary
    for (let i = 1; i < labels.length - 1; i++) {
      const parent = labels.slice(i).join('.');
      if (!isPublicSuffix(parent)) out.add(parent);
    }
  }
  return [...out].sort((a, b) => b.split('.').length - a.split('.').length || a.localeCompare(b));
}

export type ClaimDomainCheck =
  | { ok: true }
  | { ok: false; reason: 'no_hostnames' | 'unrelated'; allowed: string[] };

// The gate itself. `domain` is expected to already be a lowercased bare
// hostname (the route validates shape before calling this).
export function checkClaimDomain(
  domain: string,
  api: { baseUrls?: unknown; sourceUrl?: string | null },
): ClaimDomainCheck {
  const hostnames = apiHostnames(api);
  if (!hostnames.length) return { ok: false, reason: 'no_hostnames', allowed: [] };

  const allowed = claimableDomains(hostnames);
  const target = domain.toLowerCase().replace(/\.$/, '');
  if (allowed.includes(target)) return { ok: true };
  return { ok: false, reason: 'unrelated', allowed };
}
