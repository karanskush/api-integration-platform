# TrueAPI — Architecture & Build Plan

> **Date:** 2026-05-20
> **Status:** Approved architecture, ready to build
> **Depends on:** README.md (Vision), L2_ENGINE_SPEC.md (Engine Spec), PRICING.md (Pricing)

---

## 1. Goal

Build TrueAPI as the gold standard for API integration — an online platform
that learns how APIs *actually* behave, then serves that verified knowledge
via hosted MCP servers so AI agents (and humans) can integrate correctly in
one shot.

---

## 2. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Framework** | Next.js App Router | Dashboard + MCP endpoints + API in one app |
| **Deployment** | Vercel (Fluid Compute) | Zero-config, 300s timeout, full Node.js |
| **Database** | Neon Postgres (Vercel Marketplace) | 7 knowledge layers are relational — DAG edges, state transitions, cross-references. JSONB for flexible parts |
| **ORM** | Drizzle | Lighter than Prisma, better SQL for DAG traversal queries, first-class Neon support |
| **Auth** | Clerk (Vercel Marketplace) | Zero-config, handles provider login + API key management |
| **MCP Server** | `@modelcontextprotocol/sdk` | Official SDK, Streamable HTTP transport via API routes |
| **Probe Orchestration** | Vercel Workflow (WDK) | Durable, step-based execution — probes can take 30+ min with rate limiting |
| **UI Components** | shadcn/ui + Tailwind | Production-grade components, consistent design |
| **Graph Visualization** | React Flow | DAG and state machine visualization in dashboard |
| **LLM (Semantic Layer)** | Claude Haiku via Anthropic SDK | Batch/offline during probing, never in the MCP serving path |
| **Monorepo** | Turborepo | Independent packages, single deploy pipeline |

---

## 3. Project Structure

```
/
├── apps/
│   └── web/                          # Next.js app — everything lives here
│       ├── app/
│       │   ├── (marketing)/          # Landing, pricing, public pages
│       │   ├── (dashboard)/          # Provider dashboard (authed)
│       │   │   ├── apis/[id]/        # API config, probe status, L2 browser
│       │   │   ├── review/           # Human review/correction of L2 model
│       │   │   └── settings/
│       │   ├── api/
│       │   │   ├── mcp/[providerId]/ # Hosted MCP endpoints (Streamable HTTP)
│       │   │   ├── probes/           # Probe management + Workflow triggers
│       │   │   └── webhooks/         # Webhook receiver for probe engine
│       │   └── explorer/             # Public L2 model browser
│       ├── components/
│       └── lib/
├── packages/
│   ├── db/                           # Drizzle schema, migrations, queries
│   ├── probe-engine/                 # Pure TS — no framework deps (the moat)
│   │   ├── probes/                   # Schema, entity-trace, error, state, timing
│   │   ├── safety/                   # Read/write/money-moving classification
│   │   ├── scheduler/                # Rate limiting, call budget enforcement
│   │   └── analyzers/                # DAG inference, state machine extraction
│   ├── mcp-server/                   # MCP tool definitions and handlers
│   └── l2-model/                     # TypeScript types for all 7 layers
├── turbo.json
└── package.json
```

### Why one Next.js app, not separate services

As a solo developer, operational complexity is the enemy. A single Next.js
app on Vercel gives you: one deploy pipeline, one set of environment
variables, shared auth middleware, and zero inter-service networking. The
MCP endpoints are just API routes. The probe engine runs as Vercel Workflow
steps triggered by API routes. Split later when scale demands it.

---

## 4. Database Schema (Core Tables)

```sql
-- Customers
providers           -- API providers (customers)
api_configs         -- Per-provider API configuration (base URL, auth, environments)
endpoints           -- Discovered/imported endpoints

-- Probing
probe_runs          -- Probe execution records
probe_results       -- Raw probe results

-- The 7 Knowledge Layers
entity_dag_nodes    -- Endpoints as nodes
entity_dag_edges    -- ID-flow relationships between endpoints
state_machines      -- Entity types with states
state_transitions   -- State-to-state transitions
failure_catalog     -- Error codes, triggers, fixes
sandbox_prod_diffs  -- Environment divergences
webhook_contracts   -- Webhook behavioral specs
idempotency_maps    -- Per-endpoint idempotency behavior
cross_provider_maps -- Cross-provider ID correlations

-- MCP
mcp_servers         -- Deployed MCP server configs
mcp_sessions        -- MCP session logs (flywheel data)
mcp_usage           -- Usage metering
```

---

## 5. MCP Tool Definitions

The hosted MCP server exposes these tools to consumer AI agents:

| Tool | What It Returns |
|------|----------------|
| `get_call_sequence` | Ordered prerequisite chain to achieve a goal |
| `get_endpoint_schema` | Verified request/response schema (actual, not spec) |
| `get_failure_modes` | Real error conditions, retryability, concrete fixes |
| `get_state_machine` | Entity lifecycle states + valid transitions |
| `get_entity_dag` | Full dependency graph for an endpoint |
| `search_endpoints` | Semantic search across the API |

---

## 6. Key Design Decisions

### 6a. Probe engine is a package, not a service

`packages/probe-engine` is pure TypeScript with no runtime dependencies.
It can be invoked from Vercel Workflow, CLI, or future dedicated workers.
The moat stays portable.

### 6b. LLM is offline-only

Claude Haiku runs during probe analysis (batch). MCP responses are
pre-computed DB lookups. Low latency, predictable cost.

### 6c. Start with API key auth for MCP, add OAuth later

Ship faster. API key auth (bearer token) is sufficient for early customers.
Add spec-compliant OAuth 2.1 when customer count justifies it.

### 6d. MCP server = just a Vercel Function

Served at `/api/mcp/[providerId]`. Same DB, same deploy. No inter-service
complexity. Move to dedicated infrastructure only when scale demands it.

### 6e. Ship with layers 1–3, add 4–7 incrementally

The product is sellable with Entity DAG + State Machines + Failure Catalog.
Webhook contracts, idempotency maps, divergence maps, and cross-provider
correlation add depth over time.

---

## 7. Build Phases

### Phase 0: Bootstrap (Days 1–2)

- Turborepo monorepo with `apps/web` + `packages/*`
- Neon Postgres via Vercel Marketplace
- Clerk auth via Vercel Marketplace
- Drizzle schema for core tables
- Basic Next.js app with auth deployed to Vercel
- CI: type-check + lint on push

### Phase 1: OpenAPI Ingestion (Days 3–7)

- Upload/paste OpenAPI spec (JSON or YAML)
- Parser extracts endpoints, parameters, request/response schemas
- Store as `endpoints` rows with structured schema data
- Dashboard page showing imported endpoints
- API config form: base URL, API key (encrypted), environment label

### Phase 2: Probe Engine Core (Days 8–20)

**This is the moat.**

- **2a (Days 8–12):** Safety policy engine + schema probes
  - Classify endpoints as read/write/money-moving
  - Read-endpoint probing, schema diff vs. OpenAPI spec
  - Rate limiter, call budget enforcement, PII redaction
  - Environment provenance tagging

- **2b (Days 13–16):** Entity trace probes
  - Write-endpoint probing (dev/staging only, with opt-in)
  - ID extraction, value-matching across endpoints
  - DAG edge construction, transitive chain computation

- **2c (Days 17–20):** Error + state probes
  - Error trigger probes (omit fields, wrong types, expired tokens)
  - Failure catalog population with retryability testing
  - State transition discovery, terminal state mapping

### Phase 3: Hosted MCP Server (Days 21–30) — FIRST SELLABLE PRODUCT

- **3a (Days 21–24):** MCP tool definitions using official SDK
- **3b (Days 25–27):** Streamable HTTP transport at `/api/mcp/[providerId]`
  - API key auth, session logging for flywheel data
- **3c (Days 28–30):** Dogfood with MudraCore
  - Full probe cycle against MudraCore's API
  - Publish MudraCore's MCP server
  - **Record the demo:** AI agent integrates payments API in one shot

### Phase 4: Provider Dashboard (Days 31–45)

- **4a (Days 31–37):** Core dashboard
  - Probe run status, L2 model browser
  - Entity DAG visualization (React Flow)
  - State machine diagrams, failure catalog table

- **4b (Days 38–42):** Human review workflow
  - Inline editing of semantic descriptions
  - Approve/reject/correct DAG edges
  - Correction rate tracking (quality signal)

- **4c (Days 43–45):** Publish flow
  - Quality gate checks per L2_ENGINE_SPEC §14
  - Publish button, MCP server status page

### Phase 5: Remaining Knowledge Layers (Days 46–65)

- **5a (Days 46–52):** Webhook contracts
- **5b (Days 53–58):** Idempotency maps
- **5c (Days 59–65):** Sandbox-prod divergence + cross-provider correlation

### Phase 6: PLG Infrastructure (Days 66–80)

- Stripe billing (4 tiers per PRICING.md)
- Usage metering (MCP requests, endpoints, probe runs)
- Self-serve onboarding flow
- Marketing pages (migrate landing page to Next.js)
- Public explorer for published L2 models

---

## 8. Critical Path

```
Phase 0 → Phase 1 → Phase 2 → Phase 3
(bootstrap)  (seed)    (engine)   (MCP server)
```

Everything else can flex. The single most important deliverable is
**Phase 3c: the MudraCore demo.** An AI agent connects to the hosted
MCP server and correctly integrates MudraCore's payments API in one shot.
That 90-second demo proves the entire thesis.

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Vercel Function timeout for long probes | Vercel Workflow handles orchestration; individual steps are short HTTP calls |
| Neon cold starts for MCP queries | Use Neon "always on" compute (~$19/mo) for consistent latency |
| Probe engine complexity creep | Ship layers 1–3 first; add 4–7 incrementally |
| MCP spec evolution | Use official SDK which tracks spec changes; Streamable HTTP is stable |
| Rate limit / cost impact on provider's API | Safety policy: explicit call budget consent, hard throttling, PII redaction |

---

## 10. Success Metrics

| Metric | Target |
|--------|--------|
| **Time to First Successful Integration (TTFSI)** | Weeks → days (the core promise) |
| MudraCore demo | AI agent integrates in one shot via MCP |
| L2 model accuracy | >95% DAG edge accuracy, 100% terminal state coverage |
| Provider correction rate | <10% of L2 facts corrected during review |
| MCP response latency | <200ms p95 |

---

## Next Step

Start Phase 0: bootstrap the Turborepo monorepo, set up Next.js with
Clerk auth, provision Neon Postgres, create the Drizzle schema, and
deploy to Vercel.
