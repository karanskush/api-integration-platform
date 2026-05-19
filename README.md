# TrueAPI — Product Vision

> **Working name:** "TrueAPI" is a placeholder — rename later.
> **Status:** Vision / pre-build. No code yet.
> **Date:** 2026-05-19

---

## 1. One-liner

> A layer on top of your existing API docs that learns how the API **really**
> behaves, then serves that verified knowledge to whoever is integrating —
> increasingly an **AI agent** — so integration takes **days, not weeks** of
> back-and-forth between two dev teams.

---

## 2. The problem

Integrating with an API is slow, and the slowness is **human**, not technical.

- The **consumer team** burns engineer-weeks on Slack threads, support tickets,
  and calls: *"your docs say X, it returns Y — what's the right call order, why
  is this 409ing, what does this field mean?"*
- The **provider team** burns solutions engineers answering the same questions
  over and over. Every delayed integration is delayed revenue.

The root causes (validated against developer forums, Hacker News, dev
communities, and fintech post-mortems):

- **Docs drift from behavior.** ~75% of production APIs behave differently from
  their own OpenAPI spec — undocumented fields, wrong types, endpoints that
  don't exist, undocumented webhook delays.
- **Sandboxes are fake.** Test environments don't simulate the failure modes
  that matter; teams "find out what breaks when customers find it first."
- **Missing information.** 55% of developers cite missing/poor docs as the #1
  integration blocker. The biggest gap: *what do I call first, and where does
  this ID come from?*

## 3. The pain (and the metric)

The business pain is **integration onboarding burns weeks of cross-team
back-and-forth.** It has a dollar cost on both sides (consumer engineering time;
provider support cost + delayed revenue).

**The metric this product moves: Time to First Successful Integration (TTFSI).**
The promise we sell against: **weeks → days.**

## 4. Who pays

The **API provider** pays — faster customer activation, fewer support tickets,
shorter sales-to-live cycles. The **API consumer benefits for free.**
This is unambiguous and decides the whole go-to-market.

---

## 5. What the product is — three layers

| Layer | What it is | Role |
|-------|-----------|------|
| **L1 — Static** | The provider's existing OpenAPI spec / Postman collection | We **ingest** it as a seed. We never replace it. |
| **L2 — Behavioral** | A learned model of how the API *actually* behaves | **The engine. The moat.** |
| **L3 — Interface** | How integrators consume L2 | Hosted MCP server + web dashboard |

We are a **layer on top of existing docs**, not a replacement. No one has to
migrate. We enrich what they already have.

---

## 6. How it learns — probe-based cold start

**Decision:** the system learns by **actively probing** the API, not by
mirroring production traffic. (See Decision Log.)

Onboarding flow:

```
Provider pastes an API key + their OpenAPI/Postman collection
        ↓
We probe the API (guided exploration)
        ↓
Build L2: behavioral model + semantic layer + entity graph
        ↓
Provider reviews & corrects the model in the web dashboard
        ↓
Published as a hosted MCP server
        ↓
Consumer's AI agent integrates in one shot — call sequence & failures pre-known
```

**Why probing over traffic-mirroring:**

- **Adoption.** "Paste an API key" is a 5-minute self-serve onboarding.
  "Mirror your production traffic to a third party" is a 3-month security sale.
  This makes the product product-led-growth-able.
- **It's better for the entity graph.** Probing lets us *control call order* —
  call A, take the ID it returns, feed it into B — so we trace entity
  relationships by construction. Mirroring only shows what users happened to do.

**Safety policy for probing (non-negotiable, especially for fintech APIs):**

- **Read endpoints** — probe freely.
- **Write / money-moving endpoints** — only against a **dev/staging
  environment** or with explicit per-endpoint opt-in. Never probe writes against
  production with a live key.
- **Throttle hard** — we are spending the customer's rate limits and metered
  call budget. Get explicit consent on a call budget.
- **Redact PII** — even GET endpoints return real customer data. Strip/tokenize
  before storing.
- **Label environment provenance** — dev environments can behave differently
  from production. Every learned fact records *which environment it came from*,
  so the model never silently presents staging behavior as production truth.

---

## 7. The two knowledge layers

L2 is more than schemas. It has two layers that do the real work:

### 7a. Semantic layer — what each field *means*

Type and range are not meaning. We combine field name + spec description +
observed value patterns into a plain-language definition:

> `risk_score`: integer 0–100, higher = riskier; `null` for accounts < 24h old.

An LLM legitimately helps **here** — as *description*, reviewed by the provider
in the dashboard. Never in the correctness path.

### 7b. Correlation layer — the entity graph

The same entity wears different key names across endpoints:

```
POST /accounts   → { "id": "acc_1", "holder_id": "usr_9" }
POST /transfers  ← { "from_account_id": "acc_1", "amount": 100 }
GET  /transfers/{id} ← "txn_5"
```

The engine value-matches: `acc_1` is *produced* by `POST /accounts` as `.id` and
*consumed* by `POST /transfers` as `from_account_id` → that's an edge. Across all
endpoints this builds a **dependency DAG**:

> to make a transfer → need 2 `account_id`s → each from `POST /accounts` →
> which needs a `holder_id` from `POST /users`

**That DAG is the "getting started" guide — computed, not written.** When a
consumer's agent asks "how do I make a transfer," it gets the whole prerequisite
chain. The cross-team back-and-forth never happens, because the sequence was
*derived*.

---

## 8. Delivery — MCP + web

- **Hosted remote MCP server** (HTTP transport, OAuth) — what the consumer's AI
  agent connects to. Zero install: point the agent at a URL. The agent queries
  verified schemas, real failure modes, call sequences, and field meanings.
- **Web dashboard** — where the *provider* pastes the key + spec, watches the
  probe run, and **reviews/corrects** the semantic layer and entity graph.
  Human-in-the-loop here is what makes the output trustworthy.
- **Web explorer** — the same verified model, browsable by humans without an
  agent.

**Why the AI angle matters:** in 2026 most API integration is done with an AI
coding agent in the loop. Today that agent reads the static spec — which drifts
and lies — and hallucinates the integration. Incumbents (Stripe and others) are
shipping MCP servers and "agent-ready" docs, **but those are spec-derived.**
Ours is **behavior-verified.** That is the wedge.

---

## 9. The data flywheel

We dropped traffic-mirroring as the onboarding mechanism — but **every
integration session through our MCP server is itself traffic.** Consumers'
agents calling the API generate real-behavior data, with consent, through the
front door. The more the MCP is used, the better L2 gets. This replaces the data
we gave up by not mirroring — and it's a genuine network effect.

Traffic-mirroring is **not killed — demoted** to an optional **enterprise
fidelity tier** ("connect a production traffic feed for production-grade failure
data").

---

## 10. Build sequence — the wedge

Discipline: **one wedge.** Build in this order; do not start the next until the
previous has a user.

1. **L2 engine** — probe + inference + semantic layer + entity graph.
   *Invisible, but everything depends on it.*
2. **Hosted MCP verified-context layer** — the **first sellable product.**
   Rides the agentic-integration tailwind; zero-infra adoption; value compounds.
3. **Web dashboard** — provider config + human review of the model.
4. **Onboarding linter** — product #2 (verify a consumer's calls against the
   learned patterns). Higher friction; comes later.
5. **Q&A** — not a separate product; a query mode of the MCP layer.

## 11. Beachhead — fintech

The engine is domain-general, but **go to market on fintech APIs first:**

- Integration genuinely takes *months* there — the pain is most acute and most
  expensive.
- Domain-correctness checks (debits = credits, idempotency replay detection,
  money-conservation) differentiate us from generic tools like Postman.
- We have a free reference customer and demo: **MudraCore** (see §13).

"General API platform" walks straight into Postman / WireMock / Microcks /
Optic — crowded, no wedge. "The integration layer for APIs that move money" is a
wedge.

---

## 12. Risks & open questions

**Risks:**

- **Incumbents move the same direction.** Postman, Speakeasy, Stripe are heading
  toward agent-ready docs. Moat = *behavior-verification + entity graph*, not the
  layer itself.
- **Probing finds only failures it can trigger.** Mitigate: deliberate edge-case
  probing + the §9 flywheel + the spec.
- **Probing writes can move money / trip rate limits / cost the customer.**
  Mitigated by the §6 safety policy — but it must be enforced rigorously.
- **Dev-environment ≠ production.** Mitigated by environment-provenance labels.
- **This is a startup, not a portfolio piece.** Focus is existential. One wedge.

**Open questions:**

- Pricing model — per API? per seat? per MCP call? usage-based?
- How much human review does the model need before it's trustworthy enough to
  publish? Can review be incremental?
- Self-hosted vs SaaS for security-sensitive customers — where does probing run?
- What's the minimum L2 quality bar to publish an MCP server publicly?

## 13. MudraCore's role

MudraCore (the existing fintech-OS project) stops being "the product" and
becomes the **dogfood + proof**:

- Run the L2 engine against MudraCore's own backend.
- Expose MudraCore's payments API as a hosted MCP server.
- Demo: *an AI agent integrates MudraCore's payments API correctly in one shot*
  — because it queried verified context instead of guessing from docs.

This demo is solo-buildable and proves the entire thesis in ~90 seconds.

---

## Decision log

| Date | Decision | Why |
|------|----------|-----|
| 2026-05-19 | Product = traffic/behavior-verified API knowledge layer, delivered via MCP | "Docs lie / sandbox is fake" is the validated pain |
| 2026-05-19 | Onboarding via **active probing**, not traffic-mirroring | Probing is self-serve (PLG); mirroring is a 3-month security sale |
| 2026-05-19 | Traffic-mirroring **demoted**, not killed — enterprise fidelity tier | MCP-session usage becomes the data flywheel instead |
| 2026-05-19 | First sellable product = **hosted MCP verified-context layer** | Rides agentic-integration tailwind; zero-infra adoption |
| 2026-05-19 | Beachhead = **fintech APIs**; engine stays domain-general | Sharpest pain + domain checks differentiate from Postman |
| 2026-05-19 | MudraCore = dogfood + demo, not the product | Proves the thesis with a solo-buildable demo |

## Next step

Spec the **probe engine**: the guided-exploration algorithm that traces entities
and builds the dependency DAG, plus the read/write safety policy as enforceable
rules.
