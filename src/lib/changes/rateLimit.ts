// What a provider's rate-limit headers say the policy IS.
//
// pickCapturedHeaders has always allowlisted ratelimit-* / x-ratelimit-* on
// every probe response, and nothing read them: the values reached memory on
// every live call and were dropped. Yet "how many requests may I make, per
// what window" is one of the first things a provider's own developers know
// and one of the first things an integrator has to discover by hitting the
// wall.
//
// Only the POLICY is a durable fact. `remaining` and `reset` describe this one
// response's position inside the window and are noise a minute later, so they
// are read (to disambiguate a header family) and never carried.
//
// Two header families are in the wild:
//
//   IETF draft-ietf-httpapi-ratelimit-headers (RFC 9651 structured fields)
//     RateLimit-Policy: "burst";q=10;w=1, "daily";q=1000;w=86400
//     RateLimit:        "burst";r=7;t=1
//     — and the older draft spellings, RateLimit-Limit: 100, 100;w=60
//
//   Legacy X- headers (GitHub, Twitter, most of everyone)
//     X-RateLimit-Limit: 5000
//     X-RateLimit-Remaining / X-RateLimit-Reset (epoch or seconds — the window
//     is NOT declared, so it is reported as unknown rather than guessed)

export type RateLimitPolicy = {
  /** Policy name from a structured-field item, when the provider gave one. */
  name?: string;
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds, or null when the header family cannot say. */
  windowSeconds: number | null;
  /** Which header carried it, lowercase. */
  header: string;
  /** The header value as received, capped. */
  raw: string;
};

const MAX_POLICIES = 4;
const MAX_RAW = 120;
const MAX_LIMIT = 1_000_000_000;

const cap = (v: string) => (v.length > MAX_RAW ? v.slice(0, MAX_RAW) : v);

function positiveInt(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v.trim());
  return Number.isInteger(n) && n > 0 && n <= MAX_LIMIT ? n : null;
}

// One structured-field list: `"name";q=100;w=60, "other";q=10;w=1` or the
// bare-integer draft form `100, 100;w=60`. Tolerant on purpose — providers
// implement drafts loosely — but anything unparseable yields nothing rather
// than a guess.
function parseStructuredPolicies(header: string, raw: string): RateLimitPolicy[] {
  const out: RateLimitPolicy[] = [];
  for (const member of raw.split(',')) {
    const parts = member.split(';').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    const head = parts[0];
    const params = new Map<string, string>();
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=');
      if (eq > 0) params.set(p.slice(0, eq).trim().toLowerCase(), p.slice(eq + 1).trim());
    }
    const quoted = /^"([^"]{1,64})"$/.exec(head);
    // Quota comes from q= on the named form, or from the bare integer head on
    // the old draft form.
    const limit = quoted ? positiveInt(params.get('q')) : positiveInt(head);
    if (limit === null) continue;
    const windowSeconds = positiveInt(params.get('w'));
    out.push({
      ...(quoted ? { name: quoted[1] } : {}),
      limit,
      windowSeconds,
      header,
      raw: cap(raw),
    });
    if (out.length >= MAX_POLICIES) break;
  }
  return out;
}

export function parseRateLimitPolicies(headers: Record<string, string> | undefined): RateLimitPolicy[] {
  if (!headers) return [];
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') lower[k.toLowerCase()] = v;

  // Prefer the IETF policy header: it is the only one that states the window.
  if (lower['ratelimit-policy']) {
    const policies = parseStructuredPolicies('ratelimit-policy', lower['ratelimit-policy']);
    if (policies.length) return policies;
  }
  // Older IETF drafts put the quota on RateLimit-Limit, sometimes with ;w=.
  if (lower['ratelimit-limit']) {
    const policies = parseStructuredPolicies('ratelimit-limit', lower['ratelimit-limit']);
    if (policies.length) return policies;
  }
  // The combined `RateLimit:` header carries r= (remaining) and t= (reset),
  // not the quota, so on its own it says nothing about the policy.

  // Legacy family: the quota is stated, the window is not.
  if (lower['x-ratelimit-limit']) {
    const limit = positiveInt(lower['x-ratelimit-limit']);
    if (limit !== null) {
      return [{ limit, windowSeconds: null, header: 'x-ratelimit-limit', raw: cap(lower['x-ratelimit-limit']) }];
    }
  }
  return [];
}
