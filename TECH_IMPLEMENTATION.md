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
| MCP hosting | **One multi-tenant handler** at `mcp.spotcheck.dev/[slug]` using `mcp-handler` (Streamable HTTP transport) | No per-customer infra; endpoint tools and advisor tools resolved from the stored model by slug |
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
5. **Hosted MCP server** — `mcp.spotcheck.dev/{slug}`: exposes two tool classes. **Endpoint tools** come from `Action[]` (safety-filtered) and execute against the upstream API. **Advisor tools** answer integration questions from the evidence graph and materialized facts: call sequence, auth requirements, common errors, score explanation, and drift risk. Auth resolution order for executable endpoint tools: caller-supplied header (BYOK pass-through) → org vaulted credential (Team+, if the caller is authorized) → unauthenticated. Per-call credit metering in Redis (`INCR` + plan ceilings), per-IP and per-slug rate limits.
6. **Evidence graph** — append-only facts that explain why Spotcheck believes something: static spec facts, parser warnings, live probe observations, schema diffs, error observations, auth findings, human corrections, and CI sync deltas. Every fact carries source, environment, timestamp, confidence, and redaction status. Scores and MCP advisor tools read this graph; they do not invent conclusions directly from raw logs.
7. **Agent-Ready Score engine** *(inherits L2 spec ideas)* — before live probing exists, a cheap `scorePreview` runs static checks: auth discoverability, server URL validity, unsafe action count, missing response schemas, missing error schemas, and tool-name quality. Full score runs execute a sampled subset of read-safe actions (writes only in sandbox or with owner opt-in) and grade four sub-scores, weighted to 0–100: **Auth clarity** (is auth discoverable/satisfiable from the spec alone?), **Error quality** (do 4xx bodies explain themselves?), **Doc drift** (response shape vs spec, field-by-field), **Idempotency** (retry safety on writes, sandbox only). Scores cached in `scores`; each score stores an explanation bundle pointing to the evidence that moved it. Re-run on schedule (plan-gated cadence), CI trigger, or manual.
8. **Claim flow** — prove ownership of an unclaimed public page via DNS TXT record, `<meta>` tag on the API's docs domain, or matching email domain. Claim converts the page to owner-managed and starts the upgrade funnel.
9. **Badge** — `spotcheck.dev/badge/{slug}.svg`, edge-rendered from the cached score, cache-tagged and revalidated on score change. The badge links to the page and its score explanation: every README that embeds it is inbound distribution plus audit trail.
10. **GitHub Action** — `spotcheck/sync@v1`: on push to the spec path, POST signed payload to `/api/ci/sync` → re-import, re-verify, re-render, badge revalidate. Optional `fail-below: 80` turns the score into a CI gate.
11. **Analytics** — per-action call counts (human vs agent), failure classes, drift events, page traffic. Pro+ dashboard; also powers the "agents fumble X" claim-outreach emails.

### MCP tool strategy

Phase 0 may expose raw endpoint tools because they create the fastest magic moment. The durable product should increasingly bias agents toward higher-level advisor tools:

| Tool | Reads | Purpose |
|---|---|---|
| `search_endpoints` | actions | Find the right operation without listing the whole API |
| `get_endpoint_schema` | actions | Return parameters, response shapes, auth, safety, and examples |
| `get_call_sequence` | materialized DAG/evidence | Explain prerequisites and where IDs come from |
| `explain_error` | error findings | Map an observed status/body to likely trigger, retryability, and fix |
| `get_score_explanation` | scores + evidence | Show why the API scored the way it did |
| `generate_contract_test` | actions + evidence | Produce a smoke/CI check for a chosen operation |

Endpoint tools execute the upstream API. Advisor tools are pure reads, fast, cheap, and safe to expose broadly.

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

**Phase 0 — Instant generator (the magic moment).** Anonymous paste → ephemeral page + playground + temp MCP URL (24&nbsp;h TTL, Redis-backed, no accounts). This replaces the landing page's simulated `#demo` with the real thing. Ship: importer, normalizer, page renderer (ephemeral variant), BYOK playground, MCP handler (BYOK auth only), and static `scorePreview` so users immediately see what makes their API agent-ready or brittle. *Gate: 20 real users try it; 5 say useful; 3 share the generated page or MCP URL with someone else.*

**Phase 1 — Persistence + revenue.** Accounts/orgs, persistent public pages with slugs, hosted MCP with credit metering, Stripe billing (Launch $29 / Pro $79), waitlist → onboarding emails. Persist the versioned API model and evidence graph, even if most evidence is still static/parser-derived. *Gate: first paying users.*

**Phase 2 — Proof + spread.** Score engine v1 (read-safe probes), badge endpoint, claim flow, seed a controlled set of unofficial pages for popular public APIs, "claim your page" outbound. Unclaimed pages are docs-derived only: clearly unofficial, no verified score verdict, no vaulted credentials, no live MCP execution unless a user brings their own key for an ephemeral session, and instant takedown. *Gate: pages get external traffic; claims convert; takedown/support burden stays near zero.*

**Phase 3 — Retention + Team/Business.** GitHub Action, scheduled re-verification, private pages, credential vault, custom domains, analytics dashboard, SLA (Team $199 / Business $499). Add integration traces as a redacted flywheel: playground/MCP failures can become repros, docs patches, contract tests, and future score evidence. *Gate: $199+ plans selling.*

### Release gates

- **Phase 0:** generated page and MCP URL work from a pasted spec without account creation; destructive actions are hidden; SSRF tests pass; BYOK secrets are absent from logs.
- **Phase 1:** persistent models are versioned by spec hash; every user-visible score/preview item points to a source fact.
- **Phase 2:** verified badges require live evidence; unclaimed pages cannot imply provider endorsement.
- **Phase 3:** vaulted credentials require audit logs, per-environment scoping, and redacted trace storage before launch.

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

## 8. Crazier roadmap bets

These are not Phase 0 requirements, but the architecture should leave clean hooks for them.

1. **Agent Gauntlet** — run a real agent task against the generated MCP server and score whether it can complete a goal without hallucinated call order, missing auth, or unsafe writes. This turns "agent-ready" from a static claim into an eval.
2. **Behavioral MCP compiler** — synthesize compound tools like `create_customer_and_charge_card` from the discovered dependency DAG, instead of exposing only raw endpoint tools.
3. **Integration flight recorder** — redacted playground/MCP traces become repros, docs patches, contract tests, score evidence, and outreach emails.
4. **Mock sandbox twin** — generate a realistic mock server from observed schemas, errors, state transitions, and timing so teams can test without a broken provider sandbox.
5. **OpenAPI repair bot** — CI opens a PR that fixes missing fields, wrong response types, undocumented errors, and idempotency metadata.
6. **Signed Agent-Ready attestation** — badges link to a versioned evidence bundle: spec hash, probe date, score explanation, CI status, and verification scope.

## 9. Implementation log

### 2026-07-27

- Added field-level reasoning beneath the operation-level model: `fieldMap.ts` flattens a request/response schema into addressable paths (`body.customer.address.line1`) with type, constraints, and a `readOnly`/`writeOnly`-derived origin (`server_generated` | `constant` | `enum_constrained` | `produced_by_api` | `caller_supplied`) — the direct answer to "what data can I send here."
- Added `lineage.ts`, the field-to-field Entity Dependency DAG from §3's original sketch and L2_ENGINE_SPEC.md §3: matches producers to consumers on title/shape identity, distinctive names, foreign-key shape, resource affinity, format, and enum overlap. Precision-gated (≥95%, matching the BUILD_PLAN.md release criterion) rather than recall-optimized — a generic field name never emits an edge on its own, and a four-corpus accuracy suite (Petstore/Slack/GitHub/Stripe-shaped, chosen to each stress a different structural property) asserts it.
- Grew the advisor tool set from six to eight: `describe_fields` (the field inventory) and `trace_field` (lineage in both directions — where a value comes from, and what else accepts it). `get_endpoint_schema` and `get_call_sequence` were extended to use both under the hood, so a required body identifier is now traced individually instead of reported as one opaque `body` parameter.
- Added pagination-model detection (cursor/page/offset/none) and OAuth2/OIDC scope capture, both previously undetected/discarded by the normalizer.
- Materialized lineage edges into the evidence graph (`graph.field_lineage`, no migration — evidence_facts.kind is free text) as a durable audit record, per §5's schema note anticipating a `dag_edge` kind.
- Added a grounded natural-language ask layer (`lib/ask.ts`, `POST /api/apis/[slug]/ask`, Pro+): the model is bound to the advisor tools as callable functions and never sees raw spec text, since every advisor result already passes through the existing sanitization before this layer exists — grounding over fluency, matching how `get_call_sequence` already refuses to guess at an untraceable identifier.

### 2026-07-10

- Updated the plan scope to reflect that this repo now includes a Phase 0-style Next.js `app/` workspace, not only the static marketing site.
- Tightened BYOK language: credentials are pass-through only unless explicitly vaulted, and direct browser-to-upstream mode is preferred when CORS allows it.
- Expanded the shared model from action-only IR into a versioned API model with response schemas, error schemas, provenance, confidence, idempotency, and static score preview support.
- Added an append-only evidence graph beneath the Agent-Ready Score so score outputs can be explained, replayed, and audited.
- Split MCP strategy into endpoint execution tools and safer advisor tools such as `get_call_sequence`, `explain_error`, `get_score_explanation`, and `generate_contract_test`.
- Tightened rollout gates, especially for Phase 0 proof signals and Phase 2 unclaimed-page trust boundaries.
- Added the crazier roadmap bets that the architecture should preserve hooks for: Agent Gauntlet, behavioral MCP compiler, flight recorder, mock sandbox twin, OpenAPI repair bot, and signed attestations.
