# TrueAPI — Build Plan

> **Date:** 2026-05-22
> **Status:** Consolidated, ready to execute
> **Supersedes:** the build-phase sections of `ARCHITECTURE_2026-05-20.md` (re-sequenced around the two demos)
> **Depends on:** `README.md` (Vision), `L2_ENGINE_SPEC.md` (7-layer engine spec + research), `ARCHITECTURE_2026-05-20.md` (stack + schema), `PRICING.md` (pricing)

This plan synthesizes the vision, the research-backed 7-layer engine spec, the
approved architecture, and the live pricing into one sequenced, decision-complete
plan. It re-sequences the existing phases around a single keystone — the two
MudraCore demos — and folds in the 2026 Vercel platform reality and the Prismor
security requirements.

---

## 1. The one organizing principle

Everything serves **the two MudraCore demos** (Vision §13). Together they prove the
entire thesis in ~90 seconds:

- **Demo 1 (humans):** a developer opens the Behavior Explorer, clicks "create a
  transfer," and sees the full prerequisite chain + state machine + failure modes
  on one screen — no docs reading.
- **Demo 2 (agents):** an AI agent integrates MudraCore's payments API correctly
  **in one shot** by querying the hosted MCP server instead of guessing from docs.

The product is validated the moment both demos work. Ruthlessly minimize everything
else to reach a **Demo-Complete MVP** — that artifact is what unlocks first customers
and fundraising.

---

## 2. Three corrections to the prior plan

These are substantive sequencing/scope changes the synthesis surfaced, not cosmetics.

### 2a. The two demos pull a thin slice of "Phase 4" forward

`ARCHITECTURE_2026-05-20.md` treats the demos as the tail of Phase 3 and puts the
explorer + review UI in Phases 4/6. But:

- **Demo 1 needs explorer UI** (human-facing DAG/failure/state viewer).
- The quality gate (`L2_ENGINE_SPEC.md` §14: *"the L2 model is more dangerous at
  80% accuracy than at 0%"*) means **no MCP server can be published without a
  human approve/correct step**.

So a **minimal review UI** and a **minimal public explorer** are part of the MVP —
not deferrable. The *full* dashboard (React Flow visualizations, inline editing,
correction-rate analytics) stays deferred.

### 2b. The MCP serving path forces "materialize, don't traverse"

Architecture decision 6b (LLM offline-only) plus the **<200ms p95** target mean MCP
tools must be **pure, denormalized DB reads**. The probe/analysis step must
**pre-compute** the answers MCP returns — full transitive call sequences per goal,
flattened failure lists, resolved state machines — and store them ready-to-serve.
No DAG traversal, no multi-join, no LLM call at request time. This is a concrete
schema rule the prior doc leaves implicit.

### 2c. Build layers strictly by validated ROI

The research ranks the 7 layers:

- **L1 Entity DAG** = the **#1** time killer (60–80% of integration time is spent
  discovering call order and where IDs come from — Lunar.dev 2024).
- **L2 State Machine + L3 Failure Catalog** complete the "what do I call / what
  breaks" story.
- **L4–L7** (sandbox–prod divergence, webhook contracts, idempotency, cross-provider)
  are depth.

**The demos need only layers 1–3.** Build L4–7 *after* the thesis is validated and
there is a paying user.

---

## 3. Tech stack — 2026 corrections

Keep the approved stack (`ARCHITECTURE_2026-05-20.md` §2). Apply these updates from
the current Vercel platform reality:

| Decision | Keep / Change | Note |
|---|---|---|
| Next.js App Router on Vercel **Fluid Compute** | Keep | 300s timeout, full Node.js, reused instances |
| Neon Postgres + Drizzle | Keep | Relational fits 7 layers; **always-on** compute for MCP latency |
| Clerk auth, Turborepo, shadcn/ui, React Flow | Keep | — |
| Vercel **Workflow (WDK)** for probe orchestration | Keep | Durable multi-step probing; long runs survive timeouts |
| `@modelcontextprotocol/sdk`, Streamable HTTP | Keep | Official SDK tracks spec changes |
| **Config: `vercel.ts`** instead of `vercel.json` | **Change** | Typed config is now the recommended path |
| **LLM via Vercel AI Gateway** (`"anthropic/claude-haiku-4-5"`) | **Change** | Provider fallbacks + observability + **zero-data-retention** — critical when feeding fintech API responses to a model |
| **Vercel Queues** for webhook-probe event ingestion | **Add (M5)** | Durable at-least-once fits webhook-timing probes |
| **Vercel BotID** on public explorer + MCP endpoints | **Add (M3)** | Protect the public surfaces from abuse |

---

## 4. Milestones

Anchored to the prior day estimates, reorganized so the demo is the **gate**, not the
finale. Discipline (Vision §10): do not start the next milestone until the previous
one is real.

### M0 — Bootstrap (~2 days)

- Turborepo: `apps/web` + `packages/{db, probe-engine, mcp-server, l2-model}`.
- Neon Postgres + Clerk auth via Vercel Marketplace.
- Drizzle schema for **core tables + layers 1–3 only** (designed for materialized
  serving — see §5).
- Authed Next.js skeleton deployed to Vercel; CI: type-check + lint on push.
- **Exit:** authed app live on Vercel.

### M1 — Seed ingestion (~4 days)

- Upload/paste OpenAPI (JSON or YAML); parser extracts endpoints, params,
  request/response schemas → `endpoints` rows.
- API-config form: base URL, **encrypted** API key, environment label.
- Dashboard page listing imported endpoints.
- **Exit:** MudraCore's spec imported and listed.

### M2 — Probe engine core: the moat (~12 days)

Built safety-first. `packages/probe-engine` is pure TS, no framework deps.

- **2a — Safety + schema probes (~5 days):** read/write/money classification;
  call-budget consent; hard rate limiting; **PII redaction before any persistence**;
  environment-provenance tagging; schema diff vs. spec.
- **2b — Entity-trace probes → L1 DAG (~4 days):** write-probe (dev/staging only);
  ID extraction; value-matching across endpoints; edge construction; **transitive
  chain pre-computation** (the materialized serving artifact); lifecycle labeling
  (expiry, one-time-use, permanent).
- **2c — Error + state probes → L2/L3 (~3 days):** systematic mutation (omit fields,
  wrong types, expired tokens, duplicate requests, rate-limit violations);
  retryability testing; state-transition discovery; terminal-state mapping.
- **Exit:** MudraCore L1–L3 model populated; every fact environment-labeled.

### M3 — Demo-Complete MVP (~10 days) — **THE GATE**

The thin vertical slice that lights up both demos.

- **MCP server** at `/api/mcp/[providerId]` (Streamable HTTP, API-key auth, session
  logging for the flywheel) exposing `get_call_sequence`, `get_endpoint_schema`,
  `get_failure_modes`, `get_state_machine`, `get_entity_dag`, `search_endpoints` —
  **all pure DB reads**, behind BotID.
- **Minimal review UI:** approve/correct facts, wired to a **quality-gate check**
  (§6 thresholds) and a publish button. **No publish without passing the gate.**
- **Minimal public Behavior Explorer:** read-only DAG view + failure list + state
  viewer.
- **Both demos recorded against MudraCore.**
- **Exit:** agent integrates MudraCore's payments API in one shot; human sees the
  full chain on one screen.

### M4 — Provider dashboard, full (~14 days)

- React Flow DAG + state-machine visualizations.
- Full inline editing of semantic descriptions; approve/reject/correct DAG edges.
- Correction-rate tracking as a quality signal.
- Polished probe-run status; publish/status pages.

### M5 — Remaining knowledge layers (~20 days)

In order: **L4** sandbox–prod divergence → **L5** webhook contracts (Vercel Queues)
→ **L6** idempotency maps → **L7** cross-provider correlation. Surface each in the
explorer + MCP incrementally.

### M6 — PLG infrastructure (~14 days)

- Stripe billing for the **current 5-tier model** (Free, Starter $25, Pro, Team,
  Business + Enterprise) — *not* the stale "4 tiers" in the architecture doc.
- Usage metering (MCP requests + endpoints + probe runs).
- Self-serve onboarding flow.
- Marketing pages migrated from `site/index.html` to Next.js.
- Public explorer for all published L2 models.

---

## 5. Schema implication — the serving path

Because MCP serving is pure, denormalized, <200ms reads (§2b), the probe/analysis
step must materialize ready-to-serve artifacts alongside the normalized layer tables:

- **Per-goal call sequences:** flatten transitive DAG chains at probe time into a
  `call_sequences` table keyed by goal/endpoint, so `get_call_sequence` is a single
  row read — never a runtime graph traversal.
- **Flattened failure lists** per endpoint for `get_failure_modes`.
- **Resolved state machines** (states + transitions + terminal flags) per entity type
  for `get_state_machine`.

Keep the normalized DAG/state/failure tables for the dashboard and re-computation;
serve from the materialized denormalized copies. Use Neon **always-on** compute to
avoid cold-start latency on the MCP path.

---

## 6. Hard constraints that shape every decision

- **MCP serving = pure denormalized reads, <200ms p95.** Pre-compute at probe time;
  Neon always-on; no LLM in the request path.
- **Quality gate is a release gate, not a phase** (`L2_ENGINE_SPEC.md` §14):
  - Entity DAG: **≥95%** edge accuracy
  - State Machine: **100%** terminal-state coverage
  - Failure Catalog: **≥90%** error-code coverage
  - Provider correction rate **>10%** blocks public publish.
- **Safety policy is non-negotiable and built before any write probe** (Vision §6,
  spec §13): read = probe freely; write = dev/staging or explicit per-endpoint opt-in;
  money-moving = per-endpoint opt-in + budget; rate-limit consent; PII redaction;
  every fact environment-labeled.

---

## 7. Security (Prismor / OWASP LLM Top 10)

The probe engine is the risk surface — it holds customer API keys and autonomously
calls their APIs.

- **Secrets:** envelope-encrypt API keys at rest; never log them.
- **PII:** redact/tokenize responses **before** storage (enforce the safety policy
  rigorously, not just at design time).
- **LLM01 — prompt injection:** API responses fed to Haiku are **untrusted input**.
  The LLM writes *descriptions only, provider-reviewed, never the correctness path*
  (Vision §7a) — treat this as a security control, not just a design choice.
- **LLM06 — excessive agency:** the probe engine *is* an autonomous agent. The
  read/write/money classification + budget consent + environment labels are the
  agency-limiting controls.
- **Public surfaces:** BotID on the explorer + MCP endpoints; standard OWASP Top 10
  hygiene (parameterized queries via Drizzle, output encoding in the explorer).

---

## 8. Open questions — resolved

| Vision §12 question | Resolution |
|---|---|
| Pricing model | **Settled:** endpoints as the unit + fair-use MCP cap; generous Free tier for distribution (see `PRICING.md` / `site/index.html`) |
| How much human review before trustworthy? | **§14 quality gates** — incremental review OK; publish-gate at the thresholds in §6 |
| Self-hosted vs SaaS | **SaaS first;** VPC / self-host is an Enterprise-tier item, post-PMF |
| Min L2 quality to publish | **§14 thresholds** — the publish gate |

---

## 9. Top risks & mitigations

| Risk | Mitigation |
|---|---|
| Long probe runs vs. function timeouts | Vercel Workflow orchestration; individual steps stay short HTTP calls |
| The 80%-accuracy trap (worse than nothing) | The publish gate (§6); never ship an ungated model |
| Probing moves money / trips rate limits | Safety policy, enforced before M2b write probing |
| Incumbents move toward agent-ready docs | Moat is *behavior-verification + entity graph*, not the MCP layer itself |
| Neon cold starts on MCP path | Always-on compute; materialized serving artifacts |
| MCP spec evolution | Official SDK tracks changes; Streamable HTTP is stable |

---

## 10. Success metrics

| Metric | Target |
|---|---|
| Time to First Successful Integration (TTFSI) | weeks → days (the core promise) |
| MudraCore demo | agent integrates in one shot via MCP |
| L2 model accuracy | ≥95% DAG edge accuracy, 100% terminal-state coverage |
| Provider correction rate | <10% of L2 facts corrected during review |
| MCP response latency | <200ms p95 |

---

## 11. Immediate next action

Start **M0**: scaffold the Turborepo, provision Neon + Clerk via Vercel Marketplace,
write the Drizzle schema for core tables + layers 1–3 (designed for materialized
serving per §5), and deploy the authed skeleton to Vercel.
