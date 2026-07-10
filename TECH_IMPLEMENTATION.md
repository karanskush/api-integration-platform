# Spotcheck — Technical Implementation Plan

> **Scope.** This document specifies the **product platform** — the thing the landing page sells. The repo now contains both the static marketing site (Vite + Three.js) and a Phase 0-style Next.js app workspace under `app/` with importer, playground, MCP, SSRF guard, and ephemeral storage primitives. Treat this document as the architecture roadmap that keeps the current `app/` slice pointed at the larger product.
>
> **Historical docs.** `README.md`, `L2_ENGINE_SPEC.md`, `PRICING.md`, `ARCHITECTURE_2026-05-20.md`, and `BUILD_PLAN.md` describe the earlier "behavior-verified integration layer" framing. They remain as reference — the **Agent-Ready Score engine directly inherits the L2 probe/verification ideas**, repackaged as a shareable score instead of a hidden knowledge graph.

## 1. Positioning recap

**Wedge:** *Your API, agent-ready in 60 seconds — hosted MCP server, live playground, and a score to prove it.*

One import (OpenAPI / Postman / cURL) produces two surfaces from a single normalized intermediate representation:

- **For humans:** a public, claimable integration page with a BYOK playground.
- **For agents:** a hosted MCP server at `mcp.spotcheck.dev/{slug}`.

Plus the proof layer that differentiates us from transpilers (Speakeasy, Stainless, Mintlify): **runtime verification** → the **Agent-Ready Score** (0–100), an embeddable badge, and CI sync so drift never ships.

Adoption physics the architecture must serve:

1. **No signup before the magic moment** — paste → working page + MCP in <60s, anonymously.
2. **Every artifact is a distribution object** — public pages (SEO: "{API} MCP server"), badges, claim flow, CI checks.
3. **Credential fear solved by architecture** — BYOK by default (keys are pass-through only: never stored, logged, replayed, or reused); vaulted credentials are a paid Team feature.

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| App + API | **Next.js (App Router) on Vercel** | ISR for public pages (SEO surface), Server Actions, one deploy target |
| Compute | **Vercel Functions on Fluid Compute** (Node 24) | Instance reuse across concurrent MCP calls, 300s timeouts for probe runs |
| Database | **Neon Postgres + Drizzle ORM** | Structured orgs/apis/actions/scores; branching for preview envs |
| Queue / jobs | **Upstash QStash + Redis** | Import parsing, probe runs, scheduled re-verification; Redis for rate limits + credit counters |
| Object storage | **Vercel Blob** | Spec snapshots (versioned by content hash), rendered badge SVGs, log exports |
| MCP hosting | **One multi-tenant handler** at `mcp.spotcheck.dev/[slug]` using `mcp-handler` (Streamable HTTP transport) | No per-customer infra; tools resolved from DB by slug at request time |
| Secrets | **KMS envelope encryption** (AWS KMS or equivalent) for vaulted credentials | Per-org data keys; plaintext never at rest, never in logs |
| Billing | **Stripe** (subscriptions + metered MCP credits) | Self-serve; usage records from the credit counter |
| Auth | Email magic link + GitHub OAuth (GitHub identity doubles as claim evidence for repos) | |
| Observability | OpenTelemetry + structured logs, PII/secret redaction at the logger | Debug probe runs and MCP traffic from day one |

## 3. Core modules

All modules consume/produce one shared model — get this right first. Phase 0 can store this as one Redis blob, but the shape should already match the future Postgres model: a versioned API model plus action-level facts. That prevents the instant generator from becoming a throwaway transpiler.

```ts
// The normalized API model. Everything downstream reads this, nothing else.
type ApiModel = {
  id: string;
  slug: string;
  name: string;
  source: 'openapi' | 'swagger' | 'postman' | 'curl';
  sourceUrl?: string;
  specVersionId: string;
  baseUrls: string[];        // SSRF-validated allowlist
  dominantAuth: AuthScheme;
  authPlacement?: AuthPlacement;
  actions: Action[];
  evidenceSummary?: EvidenceSummary;
  scorePreview?: ScorePreview; // cheap static checks before full probes exist
}

type Action = {
  id: string; apiId: string;
  name: string;              // create_payment
  description: string;       // cleaned, agent-legible
  method: string; path: string;
  paramsSchema: JSONSchema;  // typed inputs incl. auth placement
  responseSchemas?: Record<string, JSONSchema>;
  errorSchemas?: Record<string, JSONSchema>;
  auth: AuthScheme;
  authPlacement?: AuthPlacement;
  safety: 'read' | 'write' | 'destructive';  // gates MCP exposure defaults
  resourceName?: string;      // payment, customer, account, etc.
  operationStability?: 'documented' | 'inferred' | 'observed' | 'drifted';
  idempotency?: 'unknown' | 'safe' | 'requires_key' | 'unsafe';
  requiresConfirmation?: boolean;
  provenance: Provenance[];   // spec, probe, correction, CI sync
  confidence: number;         // 0..1, never hide low-confidence guesses
  examples: Example[];
}
```

1. **Importer/parser** — OpenAPI 3.x + Swagger 2 (via `@readme/openapi-parser`), Postman collections, cURL paste (heuristic parse). Fetch runs in a queue job with SSRF guards (§5). Output: `spec_versions` row (blob ref + content hash) → normalizer.
2. **Action normalizer** — endpoints → `Action[]`: snake_case tool names from `operationId`/path, description cleanup (optional LLM pass, credit-metered), safety classification (GET=read; DELETE/prod-money-movement=destructive, excluded from MCP by default until owner opts in).
3. **Integration page renderer** — `spotcheck.dev/{slug}`, ISR with tag revalidation on re-import. Sections: overview, auth guide, action list with schemas + snippets (curl/TS/Python), playground, score panel, "claim this page" banner on unclaimed pages, Spotcheck badge watermark on Free.
4. **BYOK playground** — client component. Key lives in memory/`sessionStorage` only. Calls go through a thin CORS proxy (`/api/proxy`) that streams request/response, **injects nothing, persists nothing** — the visitor's key rides a pass-through header. Proxy allowlists the API's registered base URLs only. When CORS permits, direct browser-to-upstream mode is preferred so the key never traverses Spotcheck infrastructure at all.
5. **Hosted MCP server** — `mcp.spotcheck.dev/{slug}`: `tools/list` from `Action[]` (safety-filtered), `tools/call` executes against the upstream API. Auth resolution order: caller-supplied header (BYOK pass-through) → org vaulted credential (Team+, if the caller is authorized) → unauthenticated. Per-call credit metering in Redis (`INCR` + plan ceilings), per-IP and per-slug rate limits.
6. **Evidence graph** — append-only facts that explain why Spotcheck believes something: static spec facts, parser warnings, live probe observations, schema diffs, error observations, auth findings, human corrections, and CI sync deltas. Every fact carries source, environment, timestamp, confidence, and redaction status. Scores and MCP advisor tools read this graph; they do not invent conclusions directly from raw logs.
7. **Agent-Ready Score engine** *(inherits L2 spec ideas)* — a probe run executes a sampled subset of read-safe actions (writes only in sandbox or with owner opt-in) and grades four sub-scores, weighted to 0–100: **Auth clarity** (is auth discoverable/satisfiable from the spec alone?), **Error quality** (do 4xx bodies explain themselves?), **Doc drift** (response shape vs spec, field-by-field), **Idempotency** (retry safety on writes, sandbox only). Scores cached in `scores`; each score stores an explanation bundle pointing to the evidence that moved it. Re-run on schedule (plan-gated cadence), CI trigger, or manual.
8. **Claim flow** — prove ownership of an unclaimed public page via DNS TXT record, `<meta>` tag on the API's docs domain, or matching email domain. Claim converts the page to owner-managed and starts the upgrade funnel.
9. **Badge** — `spotcheck.dev/badge/{slug}.svg`, edge-rendered from the cached score, cache-tagged and revalidated on score change. The badge links to the page and its score explanation: every README that embeds it is inbound distribution plus audit trail.
10. **GitHub Action** — `spotcheck/sync@v1`: on push to the spec path, POST signed payload to `/api/ci/sync` → re-import, re-verify, re-render, badge revalidate. Optional `fail-below: 80` turns the score into a CI gate.
11. **Analytics** — per-action call counts (human vs agent), failure classes, drift events, page traffic. Pro+ dashboard; also powers the "agents fumble X" claim-outreach emails.

## 4. Data model sketch

```
users          id, email, github_id, created_at
orgs           id, name, plan, stripe_customer_id
org_members    org_id, user_id, role
apis           id, org_id?, slug, name, base_urls[], visibility(public|private),
               claim_status(unclaimed|pending|claimed), created_by?
spec_versions  id, api_id, source(openapi|postman|curl), blob_ref, content_hash, parse_status
actions        id, api_id, spec_version_id, name, method, path, params_schema,
               response_schemas, error_schemas, auth, safety, resource_name,
               idempotency, confidence, enabled_for_mcp
evidence_facts id, api_id, action_id?, kind, source, environment, confidence,
               redaction_status, payload jsonb, observed_at
schema_diffs   id, evidence_fact_id, action_id, status_code, field_path,
               expected jsonb, observed jsonb, severity
error_findings id, evidence_fact_id, action_id, status_code, trigger,
               retryable, fix_hint
auth_findings  id, evidence_fact_id, action_id?, scheme, placement,
               satisfiable_from_spec, notes
human_corrections id, api_id, user_id, target_type, target_id, before jsonb,
               after jsonb, created_at
scores         id, api_id, total, auth_clarity, error_quality, doc_drift,
               idempotency, explanation jsonb, verified_at
score_runs     id, api_id, status, probes_run, findings jsonb, started_at
credentials    id, org_id, api_id, environment, encrypted_key, kms_key_id   -- Team+
mcp_calls      id, api_id, tool, status, latency_ms, credits, caller_hash, ts
claims         id, api_id, user_id, method(dns|meta|email), token, status
waitlist       id, email, source, created_at
```

## 5. Security baseline (day one, not later)

- **Vaulted credentials:** KMS envelope encryption, per-org data keys, decrypt only inside the MCP/probe execution path, audit-logged on every use. Never in application logs (redaction at the logger, not call sites).
- **SSRF guards on all spec/URL fetches:** resolve DNS first, deny private/link-local ranges, cap size (5&nbsp;MB) and time (10&nbsp;s), no redirects across hosts.
- **Playground proxy:** allowlisted to the API's registered base URLs; strips cookies; no persistence of bodies or auth headers; direct browser mode when upstream CORS allows it.
- **MCP execution:** destructive actions off by default; per-key + per-IP rate limits; credit ceilings per plan; timeouts and response-size caps.
- **Probes:** read-only against production; writes only in sandbox environments or with explicit owner opt-in.
- **Unclaimed pages:** clearly labeled "unofficial"; instant claim-or-takedown; robots-friendly.

## 6. Phased build

**Phase 0 — Instant generator (the magic moment).** Anonymous paste → ephemeral page + playground + temp MCP URL (24&nbsp;h TTL, Redis-backed, no accounts). This replaces the landing page's simulated `#demo` with the real thing. Ship: importer, normalizer, page renderer (ephemeral variant), BYOK playground, MCP handler (BYOK auth only). *Gate: 20 real users try it; 5 say useful.*

**Phase 1 — Persistence + revenue.** Accounts/orgs, persistent public pages with slugs, hosted MCP with credit metering, Stripe billing (Launch $29 / Pro $79), waitlist → onboarding emails. *Gate: first paying users.*

**Phase 2 — Proof + spread.** Score engine v1 (read-safe probes), badge endpoint, claim flow, seed 500–1000 unofficial pages for popular public APIs, "claim your page" outbound. *Gate: pages get external traffic; claims convert.*

**Phase 3 — Retention + Team/Business.** GitHub Action, scheduled re-verification, private pages, credential vault, custom domains, analytics dashboard, SLA (Team $199 / Business $499). *Gate: $199+ plans selling.*

## 7. Landing demo → real product mapping

| Demo beat (`src/motion/importDemo.js`) | Real module | Phase |
|---|---|---|
| URL types into the import bar | Anonymous import endpoint + queue job | 0 |
| "parsed 42 endpoints · OpenAPI 3.1" | Importer/parser | 0 |
| "auth detected · bearer" | Normalizer auth detection | 0 |
| "38 tools normalized · unsafe ops flagged" | Normalizer safety classification | 0 |
| Mini playground with 200 response | BYOK playground + proxy | 0 |
| `mcp.spotcheck.dev/stripe` mints | Multi-tenant MCP handler | 0 (BYOK) / 1 (metered) |
| Score counts to 87 | Score engine | 2 |
| "Get early access" waitlist | `waitlist` table — set `data-endpoint` on `#cta-form` in `index.html`; the handler in `src/main.js` already POSTs `{email}` as JSON | 1 |

When Phase 0 ships, the hero import bar (`#hero-import`) stops scrolling to the simulation and POSTs to the real generator — the landing page is already structured for that swap.
