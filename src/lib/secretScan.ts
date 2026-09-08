// Deny-by-default secret detection over example values, applied before anything
// is stored.
//
// Every import path folds user-supplied material into OAS `example` values, and
// examples are PUBLISHED: they become each MCP tool's `inputSchema`
// (toolList.ts), the FIRST choice of sample value in generated code snippets
// (snippets.ts's sampleValue), the Playground prefill, and advisor tool output.
// A pasted cURL is simultaneously the most-encouraged onboarding action and the
// one place a user hands us a working authenticated request — so the widest
// door and the most sensitive material are the same door.
//
// The posture is deny-by-default. This module answers "is there any reason to
// think this is a credential", and the caller drops the example while KEEPING
// the schema. The costs are deliberately asymmetric: a false positive removes
// one example (the field, its type and its constraints all still reach the
// agent), a false negative publishes a live credential to a public page and a
// public MCP tool schema. The thresholds below lean toward redaction because of
// that asymmetry, not despite it.
//
// Pure and synchronous — no I/O, no env, no crypto — like fieldMap.ts,
// lineage.ts and pagination.ts. That matters: this runs inside normalize.ts,
// which serves the anonymous ephemeral import path as well as the persisted
// one, and neither may depend on a configured key.

// Vendor-issued formats that are unambiguous on sight. Anchored, and each
// requires enough trailing material that a prose mention ("pass your sk_live_
// key") cannot trip it.
const KNOWN_PREFIXES: RegExp[] = [
  /\bsk_(live|test)_[A-Za-z0-9]{10,}/, // Stripe secret / restricted
  /\brk_(live|test)_[A-Za-z0-9]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI / Anthropic style
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub PAT / OAuth / server / refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/, // GitLab
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack bot/user/app/refresh
  /\bxapp-[A-Za-z0-9-]{10,}/,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/, // Google OAuth access token
  /\bnpm_[A-Za-z0-9]{20,}/,
  /\bshp(at|ss|ca|pa)_[a-fA-F0-9]{32}\b/, // Shopify
  /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // SendGrid
  /\bdop_v1_[a-f0-9]{64}\b/, // DigitalOcean
  /\bsq0(atp|csp)-[A-Za-z0-9_-]{20,}/, // Square
];

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

// Three base64url segments. Checked structurally rather than by regex alone:
// the header must actually decode to JSON carrying an `alg`, which is what
// separates a JWT from any other dot-separated identifier.
const JWT_SHAPE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;

// Strong markers only. Deliberately NOT `auth` (matches `authorId`) or `key`
// (matches `sortKey`, `groupKey`, `idempotencyKey`) — both are common in
// ordinary parameter names, and this rule fires on the NAME regardless of what
// the value looks like, so a loose marker here is expensive.
const SENSITIVE_NAME_MARKERS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'accesskey',
  'privatekey',
  'credential',
  'signature',
  'bearer',
  'sessionid',
];

// A canonical UUID is the single most common legitimate identifier example in a
// real spec (`petId`, `customerId`). It is also high-entropy, so without this
// exemption the entropy rule would strip the examples that make an API page
// useful. Exempt from the ENTROPY rule only — a UUID sitting in a parameter
// named `session_token` is still caught by the name rule.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIN_ENTROPY_LENGTH = 24;
const ENTROPY_THRESHOLD = 4.0;
const MIN_CHARACTER_CLASSES = 3;

// Anything longer than this is not a plausible example value in the first
// place, and hashing a megabyte of pasted body to score its entropy is wasted
// work on the import hot path.
const MAX_SCANNED_LENGTH = 4096;

export type SecretReason =
  | 'known_prefix'
  | 'private_key'
  | 'jwt'
  | 'sensitive_name'
  | 'high_entropy'
  | 'oversized';

export type SecretFinding = {
  reason: SecretReason;
  // Where it was found, for the owner-facing record: a parameter name or a
  // dotted body path. Never a value.
  at: string;
  // NEVER the value. `••••` plus the last 4 characters, and only when the value
  // is long enough that 4 characters cannot meaningfully narrow it down. Same
  // rule and same shape as vault.ts's credentialHint, duplicated rather than
  // imported so this module stays free of node:crypto and env-dependent key
  // derivation — the same reason fieldMap.ts duplicates asData.
  hint: string;
  length: number;
};

export function secretHint(value: string): string {
  return value.length >= 12 ? `••••${value.slice(-4)}` : '••••';
}

// Shannon entropy in bits per character over the value's own distribution.
export function shannonEntropy(value: string): number {
  if (!value.length) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function characterClasses(value: string): number {
  let classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/[0-9]/.test(value)) classes++;
  if (/[^A-Za-z0-9]/.test(value)) classes++;
  return classes;
}

function looksLikeJwt(value: string): boolean {
  if (!JWT_SHAPE.test(value)) return false;
  const [header] = value.split('.');
  try {
    const json = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as unknown;
    return typeof json === 'object' && json !== null && 'alg' in (json as Record<string, unknown>);
  } catch {
    return false;
  }
}

function nameLooksSensitive(name: string): boolean {
  // Normalize away the casing and separator conventions that differ between
  // `X-RapidAPI-Key`, `client_secret` and `accessToken`, so one marker list
  // covers header, query and body naming styles alike.
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_NAME_MARKERS.some((marker) => normalized.includes(marker));
}

// The single classification entry point. Returns null when nothing suggests a
// credential; the caller keeps the example only in that case.
export function classifyValue(name: string, value: unknown): SecretFinding | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!text.length) return null;

  const finding = (reason: SecretReason): SecretFinding => ({
    reason,
    at: name,
    hint: secretHint(text),
    length: text.length,
  });

  // Oversized values are dropped, not waved through. MAX_SCANNED_LENGTH exists
  // because scoring a megabyte of pasted body is wasted work on the import hot
  // path — and because, as the constant says, a value that long is not a
  // plausible example in the first place. Both of those argue for discarding
  // it. Returning null here instead would have made length the one reliable
  // way past a deny-by-default filter: an 8192-bit PEM key exceeds this bound,
  // and so does any long value in a field named `client_secret`, since the
  // name check sits below this line and never got to run.
  if (text.length > MAX_SCANNED_LENGTH) return finding('oversized');

  if (PEM_BLOCK.test(text)) return finding('private_key');
  if (KNOWN_PREFIXES.some((re) => re.test(text))) return finding('known_prefix');
  if (looksLikeJwt(text)) return finding('jwt');

  // Name-based, and independent of the value's shape: a parameter called
  // `api_key` carries a credential whether its value is 6 characters or 60.
  if (nameLooksSensitive(name)) return finding('sensitive_name');

  // Entropy backstop, for credentials sitting in oddly-named parameters. Gated
  // hard so ordinary example data survives: a UUID, timestamp, URL or email is
  // never scored, and a value must be long, high-entropy AND mix at least three
  // character classes — the shape of a generated key, and rare in hand-written
  // example values. Note a hex hash (two classes) deliberately falls through.
  if (
    text.length >= MIN_ENTROPY_LENGTH &&
    !UUID.test(text) &&
    !ISO_DATE.test(text) &&
    !URL_LIKE.test(text) &&
    !EMAIL.test(text) &&
    characterClasses(text) >= MIN_CHARACTER_CLASSES &&
    shannonEntropy(text) >= ENTROPY_THRESHOLD
  ) {
    return finding('high_entropy');
  }

  return null;
}

const MAX_WALK_DEPTH = 8;

// Walks an example value, dropping secret-looking leaves and keeping the rest.
// A body example is usually an object whose sensitive fields sit beside
// perfectly good ones (`{"amount": 500, "client_secret": "..."}`), so redacting
// the whole body would throw away the example that makes the endpoint legible.
//
// Returns a NEW value; never mutates its input.
export function scrubValue(
  name: string,
  value: unknown,
  findings: SecretFinding[] = [],
  depth = 0,
): { value: unknown; findings: SecretFinding[] } {
  // Past the walk limit nothing below has been examined, so the subtree is
  // dropped rather than returned intact — the same fail-closed reasoning as the
  // length bound in classifyValue.
  if (depth > MAX_WALK_DEPTH) {
    findings.push({ reason: 'oversized', at: name, hint: '••••', length: 0 });
    return { value: undefined, findings };
  }

  if (Array.isArray(value)) {
    const out = value.map((v, i) => scrubValue(`${name}[${i}]`, v, findings, depth + 1).value);
    return { value: out, findings };
  }

  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = name ? `${name}.${key}` : key;
      // A sensitive KEY removes the whole subtree: `{"credentials": {...}}`
      // should not survive by virtue of its leaves looking innocuous.
      if (nameLooksSensitive(key) && child !== null && typeof child === 'object') {
        findings.push({ reason: 'sensitive_name', at: path, hint: '••••', length: 0 });
        continue;
      }
      const scrubbed = scrubValue(path, child, findings, depth + 1);
      if (scrubbed.value !== undefined) out[key] = scrubbed.value;
    }
    return { value: out, findings };
  }

  const finding = classifyValue(name, value);
  if (finding) {
    findings.push(finding);
    return { value: undefined, findings };
  }
  return { value, findings };
}

// Removes secret-looking `example` keys from an already-sanitized schema, at
// every depth. Mutates, deliberately: sanitizeSchema has just built this object
// fresh, so there is nothing shared to protect, and a second full deep copy on
// the import hot path buys nothing.
export function scrubSchemaExamples(
  schema: Record<string, unknown>,
  name: string,
  findings: SecretFinding[] = [],
  depth = 0,
): SecretFinding[] {
  if (depth > MAX_WALK_DEPTH) return findings;

  if ('example' in schema) {
    const scrubbed = scrubValue(name, schema.example, findings, depth);
    if (scrubbed.value === undefined) delete schema.example;
    else schema.example = scrubbed.value;
  }

  const properties = schema.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
      if (child && typeof child === 'object') {
        scrubSchemaExamples(child as Record<string, unknown>, key, findings, depth + 1);
      }
    }
  }

  if (schema.items && typeof schema.items === 'object') {
    scrubSchemaExamples(schema.items as Record<string, unknown>, name, findings, depth + 1);
  }

  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branch = schema[key];
    if (Array.isArray(branch)) {
      for (const b of branch) {
        if (b && typeof b === 'object') {
          scrubSchemaExamples(b as Record<string, unknown>, name, findings, depth + 1);
        }
      }
    }
  }

  return findings;
}

// One logical location yields one finding.
//
// A parameter is deliberately scanned twice in normalize.ts: once as the
// sanitized schema copy that becomes the MCP `inputSchema`, and once as the
// value that becomes the `examples` array. Both sinks are real and both must be
// scrubbed, so both legitimately fire on the same underlying value — but the
// owner-facing record should say "we withheld api_key", not say it twice.
// `at` is a unique location, which makes it the right dedupe key.
export function dedupeFindings(findings: SecretFinding[]): SecretFinding[] {
  const seen = new Set<string>();
  const out: SecretFinding[] = [];
  for (const finding of findings) {
    if (seen.has(finding.at)) continue;
    seen.add(finding.at);
    out.push(finding);
  }
  return out;
}
