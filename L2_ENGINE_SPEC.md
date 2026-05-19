# L2 Engine Specification — Behavioral Knowledge Model

> **Status:** Research-backed spec, pre-implementation
> **Date:** 2026-05-19
> **Depends on:** README.md (Product Vision §5–§7)

---

## 1. Why this document exists

The product vision defines L2 as "a learned model of how the API actually
behaves" with two sub-layers: a semantic layer and a correlation layer (entity
graph). Internet-wide research across 40+ developer sources — Medium, dev.to,
Stripe engineering blog, Plaid docs, Hacker News, Azure architecture guides,
fintech post-mortems — reveals that **two layers are not enough.** The real
integration pain decomposes into seven distinct knowledge layers, each
addressing a category of failure that burns engineering weeks.

This document specifies all seven layers, what each must capture, why it
matters (with concrete examples), and how the probe engine should discover it.

---

## 2. The seven knowledge layers

```
L2 Engine
├── 1. Entity Dependency DAG
├── 2. State Machine Map
├── 3. Failure Catalog
├── 4. Sandbox–Production Divergence Map
├── 5. Webhook Behavioral Contract
├── 6. Idempotency & Safety Map
└── 7. Cross-Provider Correlation Map
```

Each layer is detailed below.

---

## 3. Layer 1 — Entity Dependency DAG

### What it captures

A directed acyclic graph where **nodes** are API endpoints and **edges** are
entity-flow relationships: endpoint A's response field X is consumed as
endpoint B's request parameter Y.

### Why it matters

The #1 time killer in API integration is figuring out call ordering and where
IDs come from. 60–80% of integration time is spent discovering undocumented
third-party connections (Lunar.dev 2024).

### Real-world examples

**Plaid's 4-step token chain:**

```
POST /link/token/create
  → returns link_token (expires in 4 hours)
    → passed to frontend Link module
      → user authenticates → returns public_token (one-time-use)
        → POST /item/public_token/exchange
          → returns access_token (permanent) + item_id
            → POST /transactions/sync with access_token
              → returns transactions + next_cursor
```

Each step produces a token/ID consumed by the next. The `link_token` expires
in 4 hours, the `public_token` is one-time-use, and the `access_token` is
permanent. None of this lifecycle metadata is in the OpenAPI spec.

**Stripe Connect progressive unlocking:**

```
POST /v1/accounts (minimum: country + type=custom)
  → returns account_id
    → PATCH /v1/accounts/{id} (incrementally add identity data)
      → account achieves charges_enabled capability
        → POST /v1/accounts/{id}/external_accounts (bank account)
          → payouts_enabled unlocks
```

The account starts minimal and capabilities unlock progressively as
dependencies are satisfied. This is not a linear chain — it's a capability
tree with state-gated edges.

**KYC multi-API chain:**

```
Collect PII
  → POST identity verification API (Onfido: document OCR + biometric)
    → POST sanctions/PEP screening API (Alloy, ComplyAdvantage)
      → Risk scoring → auto-approve or manual review queue
        → POST payment system (create verified account)
          → Link verified identity to payment account
```

This chain spans 3–4 different providers. Manual: 3–7 days. Automated: <24h.

### What the DAG must store per edge

| Field | Description |
|-------|-------------|
| `source_endpoint` | The endpoint that produces the value |
| `source_field_path` | JSON path in the response (e.g., `.data.id`) |
| `target_endpoint` | The endpoint that consumes the value |
| `target_field_path` | JSON path in the request (e.g., `.from_account_id`) |
| `value_lifecycle` | Expiry, one-time-use, permanent, environment-specific |
| `state_gate` | Entity state required for this edge to be valid |
| `async` | Whether this edge is fulfilled via webhook vs. sync response |
| `environment_provenance` | Which environment this relationship was observed in |

### How the probe engine discovers it

1. **Probe a write endpoint** → capture all ID-shaped values in the response.
2. **For each ID**, attempt to use it as input to every other endpoint that
   accepts a parameter of matching type/format.
3. **Value-match**: when the same literal value appears in a response field and
   a request field across two endpoints, record the edge.
4. **Trace transitively**: if A → B → C, record the full prerequisite chain.
5. **Test lifecycle**: retry a one-time-use token → confirm it fails → label it.

---

## 4. Layer 2 — State Machine Map

### What it captures

For each major entity type (payment, account, subscription, order, item), the
set of **states** the entity can occupy, the **transitions** between states,
which **API calls** trigger each transition, and which transitions are
**irreversible**.

### Why it matters

Every serious API has entities with state machines that are poorly documented.
Developers assume wrong transitions, hit unexpected errors, and spend days
debugging state-related failures.

### Real-world examples

**Stripe PaymentIntent — 7 states, no `failed` state:**

```
requires_payment_method
  → requires_confirmation
    → requires_action (3D Secure, redirect)
      → processing
        → succeeded (terminal)
        → requires_capture (authorize-and-capture flow)
          → succeeded
  → canceled (terminal, triggerable before processing/succeeded)
```

Critical design decision: there is NO `failed` state. If a payment attempt
fails, the PaymentIntent loops back to `requires_payment_method` so the
customer can try again. This is fundamentally different from the old Charge
API (which had a terminal `failed` state), and most developers assume wrong.

**Stripe's old Sources API — dangerous dual state machines:**

The Sources API had TWO interdependent state machines (Source + Charge):
- Browser disconnection after payment could prevent Charge creation
- Money would auto-refund if server-side Charge request failed
- Developers had to build parallel integrations: synchronous HTTP + webhooks
- Had to track both Charge ID and Source ID to prevent double-charging

PaymentIntents collapsed this into a single state machine — proving that state
machine complexity is a real, money-losing problem.

**Shopify FulfillmentOrder:**

```
open → (fulfillment request sent)
  → in_progress → (fulfillment service accepts)
    → closed → (all line items fulfilled)
```

Rule: merchant cannot modify order after 3PL accepts — must request
cancellation first. Partial fulfillments keep the order in `in_progress`.

**Plaid Item lifecycle:**

```
connected → ITEM_LOGIN_REQUIRED → (user re-authenticates via Link update mode)
  → connected
```

`ITEM_LOGIN_REQUIRED` fires when user changes password, MFA settings change,
or OAuth authorization expires. This error **never fires in sandbox** — most
teams never build the re-authentication path because they never encounter it
during development.

### What the state map must store

| Field | Description |
|-------|-------------|
| `entity_type` | The API resource (PaymentIntent, Item, Account) |
| `states` | List of observed states |
| `transitions` | From-state → to-state + triggering API call |
| `terminal_states` | States with no outgoing transitions |
| `reversible` | Whether the transition can be undone |
| `loop_transitions` | States that loop back (e.g., failed → retry) |
| `environment_notes` | States/transitions that only appear in specific environments |

### How the probe engine discovers it

1. **Create an entity** → record initial state.
2. **Call every relevant endpoint** against the entity → observe state changes.
3. **Attempt invalid transitions** → record which produce errors vs. succeed.
4. **Map terminal states** → attempt all operations against a terminal entity.
5. **Compare environments** → flag states that only appear in production.

---

## 5. Layer 3 — Failure Catalog

### What it captures

Every error code the API can return, mapped to the **actual condition** that
triggers it (not the generic description from docs), whether it's
**retryable**, and the **concrete fix**.

### Why it matters

Developers cite undocumented/unclear errors as a top-3 integration blocker.
Generic error messages like "400 Bad Request" provide zero diagnostic value.
52% of developers faced production crashes from unannounced breaking changes
in 2024 (Salt Labs).

### Real-world examples

**Stripe webhook signature — zero-clue silent failure:**

Framework parses `req.body` into a JS object before the handler runs.
Re-serialized JSON (`JSON.stringify(req.body)`) doesn't match Stripe's
original bytes. Signature verification fails. Error message gives **zero
indication** of root cause. Fix: use `req.rawBody`.

**AWS EventBridge + Batch — silent JSON trap:**

EventBridge Rules require PascalCase keys (`ContainerOverrides`, `Command`)
when targeting Batch. Developers use camelCase (natural from SDK examples).
No error is returned. The job executes with **default configuration**,
completely ignoring custom overrides. Spent "hours" debugging with no
indication of what was wrong.

**Plaid PRODUCT_NOT_READY:**

Sandbox returns data synchronously. Production uses async first pull. Calling
`/transactions/get` immediately after token exchange → `PRODUCT_NOT_READY`.
This error never appears in sandbox — developers discover it only in
production.

**Twilio Error 11200 — one code, five failures:**

HTTP Retrieval Failure covers: webhook URL unreachable, non-2xx response,
expired SSL certificate, response exceeding 15-second timeout, AND server
errors. All produce the same error code. Debugging requires correlating
across Twilio, the webhook server, and any downstream services.

**Onfido location validation:**

Every applicant MUST have location data, or Document/Facial Similarity/Known
Faces reports fail with validation errors. If IP-based geolocation fails,
you must explicitly collect country of residence. This is buried deep in
the docs and easy to miss.

### What the failure catalog must store

| Field | Description |
|-------|-------------|
| `endpoint` | The endpoint that returns this error |
| `error_code` | HTTP status + API-specific error code |
| `trigger_condition` | The actual condition (not the docs description) |
| `retryable` | Yes/no + retry strategy (backoff, delay, key rotation) |
| `environment_specific` | Does this error only appear in certain environments? |
| `fix` | The concrete resolution |
| `related_state` | Entity state that causes this error |
| `frequency` | How often this error is observed during probing |

### How the probe engine discovers it

1. **Send valid requests** → catalog success patterns.
2. **Systematically mutate** → omit required fields, send wrong types, use
   expired tokens, send duplicate requests, violate rate limits.
3. **Record every distinct error response** → deduplicate by root cause.
4. **Test retryability** → retry identical request after each error.
5. **Trigger state-dependent errors** → call endpoints against entities in
   every known state.

---

## 6. Layer 4 — Sandbox–Production Divergence Map

### What it captures

A structured diff between sandbox and production behavior for the same API —
endpoints, error codes, timing, data quality, and features that behave
differently across environments.

### Why it matters

This came up in **every single fintech API** researched. Sandbox environments
are designed for convenience, not fidelity. Teams build against sandbox, ship
to production, and discover a different API.

### Real-world examples

| API | Sandbox Behavior | Production Behavior |
|-----|-----------------|---------------------|
| **Plaid OAuth** | Simple credential-based test flows | Bank-specific redirect to Chase/BofA/Citi login |
| **Plaid data** | Synchronous response | Async with webhooks, 1–5s delay |
| **Plaid institutions** | Always available, consistent | Transient outages, bank maintenance windows |
| **Plaid transactions** | Consistent format | Merchant descriptions vary by bank |
| **Stripe webhooks** | Near-instant delivery | Can be delayed, out-of-order, duplicated |
| **ACH settlement** | Instant | 3–5 business days |
| **ACH returns** | Limited simulation | 85+ return codes (R01–R85) |
| **Onfido location** | No validation | Location MANDATORY or reports fail |
| **Plaid ITEM_LOGIN_REQUIRED** | Never fires | Fires on credential change, MFA change, OAuth expiry |
| **Plaid rate limits** | Negligible | Real constraint requiring sync-based architecture |
| **3DS authentication** | Auto-approved | Two paths: frictionless vs. challenge |

**Plaid's specific production-only errors:**

- `ITEM_LOGIN_REQUIRED` — never occurs organically in sandbox
- `PRODUCT_NOT_READY` — sandbox is synchronous, production is async
- `INSTITUTION_DOWN` / `INSTITUTION_NOT_RESPONDING` — sandbox institutions never go down
- `RATE_LIMIT_EXCEEDED` — negligible in sandbox, architectural constraint in production

### What the divergence map must store

| Field | Description |
|-------|-------------|
| `endpoint` | The affected endpoint |
| `aspect` | What diverges (timing, errors, data shape, auth flow) |
| `sandbox_behavior` | Observed behavior in sandbox/dev |
| `production_behavior` | Observed or documented behavior in production |
| `severity` | Impact if the developer doesn't know (low/medium/high/critical) |
| `mitigation` | What to build to handle the production behavior |

### How the probe engine discovers it

1. **Probe both environments** (when the provider gives keys for both).
2. **Diff response shapes, timing, error codes, and data patterns**.
3. **For production-only behaviors**: ingest from provider documentation,
   community reports, and the MCP session flywheel (§9 in vision doc).
4. **Flag high-severity divergences** for provider review in the dashboard.

---

## 7. Layer 5 — Webhook Behavioral Contract

### What it captures

The actual runtime behavior of an API's webhook system: delivery timing,
retry policy, ordering guarantees, timeout thresholds, and idempotency
requirements.

### Why it matters

Webhooks are where **the most money gets lost** in fintech integrations.
Average webhook failure rate: 3.5% (Svix 2024). 15% of implementations have
no retry mechanism. A SaaS company lost $14,000/month from failed Stripe
webhook handling alone.

### Real-world examples

**Stripe webhook race condition (affects ~1% of signups):**

```
0ms:   User completes payment
50ms:  Webhook handler starts processing customer.subscription.created
60ms:  User redirected to /checkout/return
70ms:  Eager sync checks DB: "already processed?" → No (webhook hasn't committed)
80ms:  Eager sync starts processing
90ms:  Webhook commits transaction
100ms: Eager sync commits → DUPLICATE TRANSACTION
```

Three attempted fixes failed (DB locks → deadlocks, unique constraints →
partial failures, Redis idempotency keys → stuck payments). The actual fix:
single-writer pattern with a message queue.

**Stripe's five silent webhook failure modes:**

1. Signature verification fails because framework auto-parses `req.body`
2. Test-mode signing secret deployed to production
3. At-least-once delivery causes duplicate processing
4. 10-second timeout exceeded by synchronous heavy operations
5. Stale data in webhook payload (event fired before latest update)

**Plaid webhook contract:**

- Must respond within 200ms
- Retry: 4× exponential backoff starting at 30s, up to 24h
- If >90% of webhooks rejected in 24h, Plaid stops retrying entirely
- `INITIAL_UPDATE` vs. `HISTORICAL_UPDATE` arrive at different times

**The universal dirty secret:**

Payment gateway docs bury this: "Set up a re-query service that polls for
transaction status at regular intervals." This is an admission that webhooks
alone are insufficient. You MUST implement polling reconciliation as a safety
net.

### What the webhook contract must store

| Field | Description |
|-------|-------------|
| `event_type` | The webhook event name |
| `trigger` | What API action/state change fires this event |
| `delivery_timing` | Observed latency (min/avg/max) |
| `timeout_threshold` | How long the provider waits for 2xx |
| `retry_policy` | Retry count, backoff strategy, max retry window |
| `ordering_guarantee` | Whether events can arrive out of order |
| `idempotency_field` | Which field to use for deduplication (e.g., `event.id`) |
| `payload_staleness` | Whether payload reflects state at fire-time or delivery-time |
| `known_race_conditions` | Documented ordering violations between event types |

### How the probe engine discovers it

1. **Register a webhook endpoint** during probing.
2. **Trigger events** via API calls → measure delivery latency.
3. **Trigger multiple events rapidly** → observe ordering.
4. **Delay response** → observe retry behavior and timeout threshold.
5. **Reject webhooks** → observe retry policy and eventual abandonment.

---

## 8. Layer 6 — Idempotency & Safety Map

### What it captures

Per-endpoint idempotency mechanisms, key formats, cache durations, and
behavioral gotchas — everything needed to safely retry operations.

### Why it matters

Double-charging a customer, sending duplicate emails, or provisioning
redundant subscriptions are **real money-losing failures** that happen when
idempotency is misunderstood. Every payment API handles it differently.

### Real-world examples

| Provider | Mechanism | Key Detail |
|----------|-----------|------------|
| **Stripe** | `Idempotency-Key` header | 24h cache. Same key + different params = 400 error. **Caches failures too** — a transient 500 gets "stuck" for 24h if you reuse the key. |
| **Omise** | `Idempotency-Key` header | Only applies to initial charge, NOT 3DS redirect callbacks. Must correlate separately. |
| **2C2P** | `invoiceNo` in payload | Order ID must be persisted BEFORE calling the API. Generating inside the payment function defeats deduplication. |
| **PayPal** | `PayPal-Request-Id` header | Different header name, same concept. Correlates requests for safe retries. |

**The "Rocket Ride" failure scenarios (Stripe engineering blog):**

1. Connection failure before processing → server sees ID first time, processes normally
2. Mid-operation failure → server uses ACID rollback, safe to retry wholesale
3. Response delivery failure → server replies with cached result of the successful operation

**Critical design rule:** Always generate idempotency keys **client-side.**
If the server generates the key, a retry after a timeout produces a new key,
completely bypassing the deduplication layer.

### What the idempotency map must store

| Field | Description |
|-------|-------------|
| `endpoint` | The endpoint |
| `mechanism` | Header name, payload field, or implicit |
| `key_format` | UUID, order ID, custom format |
| `cache_duration` | How long the key is valid |
| `failure_caching` | Whether failed responses are also cached |
| `scope` | Which operations the key covers (e.g., charge only, not 3DS callback) |
| `conflict_behavior` | What happens on key reuse with different parameters |

### How the probe engine discovers it

1. **Send identical request twice** with same idempotency key → observe: same response? new response? error?
2. **Send same key with different params** → observe conflict behavior.
3. **Wait and retry** → discover cache expiration.
4. **Send request that fails, then retry with same key** → discover failure caching.

---

## 9. Layer 7 — Cross-Provider Correlation Map

### What it captures

When an integration spans multiple APIs (which fintech always does), how IDs
and entities from one provider map to another.

### Why it matters

Real integrations are never single-API. A payment flow might touch Stripe
(payments) + Plaid (bank verification) + Onfido (KYC) + SendGrid (emails).
Each provider uses different identifiers for the same logical entity, and no
one maps these relationships.

### Real-world examples

**Voice AI stack — zero automatic correlation:**

- Twilio uses `CallSid`
- ElevenLabs uses `history_item_id`
- Vapi uses internal `call_id`
- Teams check each provider independently and miss failures between providers

**Payment orchestration normalization nightmare:**

Different processors return transaction statuses, decline codes, and
settlement records in completely different formats. Normalizing into a unified
model is essential but extremely difficult.

**Shopify fulfillment chain across 3 APIs:**

```
Shopify webhook (order_id, line_items)
  → Shippo POST /shipments/ (returns rate_object_id)
    → Shippo POST /transactions/ (returns label_url + tracking_number)
      → Resend POST /emails (sends tracking_number to customer)
```

Each API has its own ID namespace. The `order_id` from Shopify becomes
metadata in Shippo; the `tracking_number` from Shippo becomes content in
Resend.

**ACH return code normalization:**

85+ NACHA return codes (R01–R85), each requiring different handling. Many
provider APIs collapse multiple codes into generic failures, hiding whether
the error is retryable or terminal. Some don't surface raw NACHA codes at all.

| Code | Meaning | Return Window | Retryable? |
|------|---------|--------------|------------|
| R01 | Insufficient Funds | 2 banking days | Yes, up to 2× |
| R10 | Not Authorized | 60 calendar days | NO — violates Nacha rules |
| R02 | Account Closed | 2 banking days | No |
| R03 | No Account | 2 banking days | No |

Nacha compliance thresholds: unauthorized returns must stay below 0.5%;
overall returns must stay below 15%. Exceeding triggers enforcement action.

### What the correlation map must store

| Field | Description |
|-------|-------------|
| `provider_a` | Source provider |
| `provider_a_field` | The field in provider A's response |
| `provider_b` | Target provider |
| `provider_b_field` | The field in provider B's request |
| `mapping_type` | Direct (same value), transformed (format change), or semantic (same entity, different representation) |
| `normalization_rules` | How to convert between representations |

### How the probe engine discovers it

1. **When onboarding multiple APIs for the same provider**, trace IDs across them.
2. **Value-match** across provider responses and requests.
3. **Ingest from community knowledge** and provider documentation.
4. **Learn from MCP session data** (the flywheel — §9 in vision doc).

---

## 10. Validated market numbers

These statistics from the research justify each layer's priority:

### Time & cost impact

| Metric | Value | Source |
|--------|-------|--------|
| Developers spending 10+ hrs/week on API tasks | 69% | Postman 2025 State of API |
| Companies spending more time troubleshooting than building | 36% | Lunar.dev 2024 |
| Companies with API issues requiring weekly attention | 88% | Lunar.dev 2024 |
| Developers citing poor documentation as #1 blocker | 55% | Multiple sources |
| Developer time spent debugging and manual testing | 17% | Industry average |
| API integration identified as most time-consuming task | 43% of devs | Adalo 2025 |
| Production crashes from unannounced breaking changes | 52% of devs | Salt Labs 2024 |

### Dollar cost

| Scenario | Cost | Source |
|----------|------|--------|
| Average API security incident per enterprise | $591,404 | Salt Security |
| Custom payment processing integration | $150K–$800K | Netguru |
| CRM integration | $20K–$40K | Industry average |
| Annual API integration cost (traditional) | $48K + 40–120 dev hours | Multiple |
| Maintenance: 15–25% of annual dev time | Ongoing | Multiple |

### Real-world failure costs

| Failure | Impact | Root cause |
|---------|--------|------------|
| Stripe webhook race condition | 1% of signups fail | `invoice.paid` before `customer.subscription.created` |
| Failed webhook handling | $14,000/month revenue loss | Missing idempotency + retry logic |
| Synapse/Evolve Bank collapse | $85M frozen funds | Batch reconciliation instead of continuous |
| Undelivered digital products | 200+ orders | `checkout.session.completed` ≠ payment collected |
| "4-hour" payment integration | 3–5 days actual | Undocumented auth, webhooks, error states |

### MCP opportunity

| Metric | Value | Source |
|--------|-------|--------|
| Monthly MCP SDK downloads (2026) | 97M+ | Dev.to |
| MCP development time reduction | 40–60% | Multiple |
| Official MCP servers | 50+ | Anthropic ecosystem |
| Community MCP implementations | 150+ | Dev.to |

---

## 11. Competitive landscape — what incumbents lack

| Competitor | What they have | What they lack |
|-----------|---------------|---------------|
| **Postman / Swagger** | Static spec rendering, collections | No behavioral truth, no entity graph, no failure catalog |
| **Stripe's MCP server** | Spec-derived MCP tools | Still the spec — if spec drifts, MCP lies. Doesn't know about webhook race conditions costing $14K/month |
| **Speakeasy** | SDK generation from spec | SDKs encode the spec's bugs into compiled code |
| **Optic** | Spec drift detection | Finds drift but doesn't resolve it into usable integration knowledge |
| **Akto** | API dependency graph (runtime) | Traffic-based, not semantic. Doesn't capture field-level entity flow |
| **Speedscale** | Live traffic dependency graphs | Requires traffic mirroring (3-month security sale). No semantic layer |
| **WireMock / Microcks** | API mocking | Mocks the spec, not reality. Same lies, faster |

**TrueAPI's wedge:** We don't just detect that the spec is wrong — we
**replace the wrong answer with the right one**, packaged as verified context
that an AI agent can consume in one shot.

### Stripe's own benchmark validates the problem

Stripe built a benchmark to test whether AI agents can build real
integrations. Findings:

- Agents pass in nonexistent data, observe 400 errors, and consider the task
  complete
- Agents get stuck in multi-step browser flows and abandon tasks
- Agents create malformed tool calls and conclude as "done" despite failing
  all tests

**An AI agent without behavioral knowledge reliably produces broken,
money-losing integrations.** This is exactly what TrueAPI solves.

---

## 12. Integration patterns the engine must understand

### Orchestration patterns

| Pattern | Description | Example |
|---------|-------------|---------|
| **Chaining** | Output of A → input of B | Shopify order → Shippo shipment → Shippo label → Resend email |
| **Aggregation** | Multiple sources combined into single response | Food delivery: orders + restaurants + payments |
| **Branching** | Conditional routing based on response data | Sales quote: discount > threshold → manual approval path |
| **Saga** | Multi-step with compensating transactions | Book flight + hotel + car; cancel flight if hotel fails |

### Saga transaction types

1. **Compensable** — can be undone (reserve inventory)
2. **Pivot** — point of no return (charge the card)
3. **Retryable** — idempotent, must complete (send confirmation email)

The DAG must annotate which edges are compensable and what the compensating
action is. Every forward edge in a saga has a potential reverse edge.

### Resilience patterns the MCP should recommend

1. **Retries with exponential backoff** — don't hammer a struggling service
2. **Circuit breakers** — stop calling a consistently failing service (Closed → Open → Half-Open)
3. **Bulkheads** — limit concurrency so one slow API doesn't exhaust resources
4. **Timeouts** — never wait forever
5. **Polling reconciliation** — safety net for unreliable webhooks

---

## 13. Probe engine design implications

Based on the seven layers, the probe engine must support these probe types:

| Probe Type | What It Discovers | Safety Level |
|-----------|-------------------|-------------|
| **Schema probe** | Request/response shapes, required vs optional fields | Safe (read) |
| **Entity trace probe** | ID flow between endpoints, DAG construction | Requires write |
| **State transition probe** | Entity lifecycle, valid/invalid transitions | Requires write |
| **Error trigger probe** | Failure conditions, error codes, retryability | Safe (read + invalid writes) |
| **Timing probe** | Webhook latency, async behavior, rate limits | Safe (read) |
| **Idempotency probe** | Key behavior, cache duration, failure caching | Requires write |
| **Environment diff probe** | Sandbox vs production divergence | Requires both environments |

### Safety enforcement (from vision doc §6, reinforced)

- **Read endpoints** — probe freely
- **Write endpoints** — only against dev/staging or with explicit opt-in
- **Money-moving endpoints** — require explicit per-endpoint opt-in + budget
- **Rate limiting** — get explicit consent on call budget before probing
- **PII redaction** — strip/tokenize before storing any response data
- **Environment labels** — every learned fact records which environment it came from

---

## 14. Quality gates

The L2 model is more dangerous at 80% accuracy than at 0%. Wrong sequences
and incorrect failure information cause integrators to trust and fail harder.

### Minimum viable quality before publishing

| Layer | Quality Gate | Rationale |
|-------|-------------|-----------|
| Entity DAG | >95% edge accuracy | Wrong call sequences are worse than no guidance |
| State Machine | 100% terminal state coverage | Missing a terminal state = unrecoverable errors |
| Failure Catalog | >90% error code coverage | Missing errors = unhandled production crashes |
| Sandbox Divergence | All critical divergences flagged | Missing a production-only error = launch-day failures |
| Webhook Contract | Timeout + retry policy verified | Wrong timeout = duplicate processing |
| Idempotency Map | 100% accuracy on write endpoints | Wrong idempotency guidance = double charges |
| Cross-Provider Map | Best-effort, provider-reviewed | This layer improves with the flywheel |

### Provider review rate as quality signal

If the provider corrects >10% of L2 facts during dashboard review, the
engine needs improvement before that API's MCP is published publicly.

---

## 15. The data flywheel — how L2 improves over time

```
Provider onboards API
  → Engine probes → builds initial L2
    → Provider reviews/corrects in dashboard
      → Published as hosted MCP server
        → Consumer AI agents integrate via MCP
          → Every MCP session generates real-behavior data
            → L2 improves → fewer provider corrections needed
              → More consumers trust the MCP → more sessions → better L2
```

The flywheel compounds: more usage → better model → more trust → more usage.

Optional enterprise tier: traffic-mirroring from production for highest
fidelity on failure modes that probing can't trigger.

---

## 16. Sources

All findings in this document are sourced from real developer experiences:

- Stripe Engineering Blog — payment API design, idempotency patterns
- Stripe Developer Blog — webhook race conditions, building solid integrations
- Plaid Documentation — sandbox vs. production behavior, Item errors
- DEV Community — API documentation drift, breaking change monitoring, MCP adoption
- Medium / Criteo Engineering — OpenAPI spec discrepancy detection
- Microsoft Azure Architecture — saga patterns, circuit breakers
- Hacker News — developer discussions on Stripe integration complexity
- Lunar.dev 2024 Report — API consumer pain points, time spent troubleshooting
- Postman 2025 State of API — developer time allocation
- Salt Security — API security incident costs
- Modern Treasury — ACH return codes, ledger requirements
- Svix — webhook failure rate research
- Microservices.io — saga pattern reference
- Speedscale, Akto — dependency graph tooling approaches
- Shopify Partners Blog — fulfillment API state machines
- Various fintech blogs — Adyen, Razorpay, payment orchestration

---

## Next step

Design the **probe execution engine**: the runtime that executes probe
sequences, respects the safety policy, manages rate-limit budgets, and
populates all seven knowledge layers. This includes the guided-exploration
algorithm, the entity-tracing state machine, and the quality-assessment
pipeline.
