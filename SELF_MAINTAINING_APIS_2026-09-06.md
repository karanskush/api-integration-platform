# Self-Maintaining API Twin — Continuous Reconciliation

> **Date:** 2026-09-06
> **Status:** Proposal. Companion to `MASTER_TECHNICAL_PLAN.md` (authoritative spine) and `GAP_ANALYSIS_2026-08-04.md` (v2). This document promotes two items those documents already contain but bury — "scheduled drift and CI release gates" (master plan backlog item 39 of 40) and "release diffing as a product" (gap analysis §7.6) — into a single first-class capability with its own vertical slice.
> **Method:** repository read (the code paths named below were opened, not inferred), then a web survey of the September 2026 landscape. Every vendor claim carries its source in Appendix A. Where a circulating number could not be traced to its primary source, it is marked as such and not used.

The product promise this enables, in one line:

> **Docs that cannot go stale.** Whatever the provider ships, the page, the hosted MCP server, and every watcher know about it, with evidence, before the provider's customers find out the hard way — and the provider receives a drafted spec patch and changelog entry instead of a support ticket.

The user-facing motivation is simple and universally true: nobody remembers to update API documentation. Today DocentAPI mitigates that with a spec-only CI hook and a Business-tier weekly re-probe. Neither produces a diff, neither notifies anyone, and neither can see a behavior change the spec does not mention. This document specifies the missing loop.

---

## 0. The governing rule, inherited

The gap analysis's one rule applies here verbatim and is the reason this design is safe to build:

> Signals may change **what DocentAPI investigates**; only governed observations may change **what DocentAPI believes**.

A changelog page, an LLM extraction, a consumer's failed MCP call, or a vendor header is a *signal*. Each schedules a probe or opens a review item. None of them is evidence. Evidence enters only through the observation → claim → release pipeline the master plan already defines (§15), version-fenced (gap §0.3), with coverage denominators (§17.1).

---

## 1. Where we are: inventory of the parts that already exist

The detection loop is roughly a third built, as disconnected pieces. The reconciliation, classification, publication, and notification layers do not exist. Each row below was verified against the file named.

| Primitive | Where | State today | Gap |
|---|---|---|---|
| **CI push sync** | `src/app/api/ci/sync/route.ts`, `src/lib/ciSync.ts`, `examples/github-action/docentapi-sync.yml` | Works. HMAC-signed, replay-guarded. Re-imports, recomputes the static preview, purges page and badge. | Computes **no diff** between versions. Notifies **no one**. Does **not** trigger a re-probe. Cannot express "we deployed but the spec did not change." |
| **Scheduled re-verification** | `src/lib/reverify.ts`, `src/app/api/cron/reverify/route.ts`, `vercel.json` (daily 04:00) | Re-fetches `sourceUrl`, re-imports, re-probes, batch of 5. | Business plan only (`plans.ts:88`); weekly; candidacy keyed on score *age* (`reverify.ts:91`), not on change; unconditional refetch (no ETag / `If-Modified-Since`); refetch failures logged and dropped. |
| **Spec versioning** | `spec_versions.content_hash`, `actions.action_key` (stable `hash(method+path)` across versions), `buildReimportStatements` in `src/lib/persist.ts` | Every re-import produces `unchanged` / `reverted` / `updated` and a full new `actions` row set. | **No version-to-version diff exists anywhere** (`grep -ril diff src/lib` excluding tests returns nothing). The stable `action_key` and `fieldMapFor()` paths (`src/lib/fieldMap.ts:329`) make an IR-level diff straightforward. |
| **Doc-drift probe** | `src/lib/probes/docDrift.ts` | Compares top-level keys and `typeof` for ≤3 read operations. | Shallow by design (comment says so). Compares to the **spec** only, never to the **previous observation**, so a behavior change the spec is silent about is invisible. Never checks status (gap §0.2). |
| **Evidence kinds for change** | `src/lib/db/schema.ts:150-156` comments anticipate `schema_diff` kind and `ci_sync` source | Anticipated. | Never written by any code path. |
| **`operation_stability`** | `schema.ts:134`: `documented \| inferred \| observed \| drifted` | Column exists. | Only reference in `src/lib` is the schema definition; nothing ever sets it. |
| **Response headers** | `src/lib/upstream.ts` builds *request* headers; `src/lib/mcpTools.ts:125` and `src/app/api/proxy/route.ts:80` pass them through | Upstream calls are made continuously (probes, MCP, playground). | **Response headers are discarded** except `content-type` in the proxy. `Deprecation` (RFC 9745), `Sunset` (RFC 8594), `Link rel="successor-version"`, and vendor version headers are invisible to the system. |
| **MCP call ledger** | `mcp_calls` (`schema.ts:260`): `tool`, `status`, `latency_ms`, `caller_hash` | Real consumer traffic is recorded per tool. | Read only by analytics. Never used as a change signal. |
| **Clarification loop** | `src/lib/clarify/*` (triage, synthesize, signed email envelopes) | Built and working. | Field-semantics questions only; no "we observed X, is it intended?" question type. |
| **Docs crawler** | `src/lib/docsCrawler.ts` | Bounded crawl feeding enrichment. | No page classification; the master plan (§9.4) asks for a `changelog` class that does not exist. |
| **Hosted MCP** | `src/app/mcp/[id]/route.ts` | Stateless `mcp-handler`; tool `inputSchema` is the current spec version verbatim. | No `tools/list` cache hints, no `listChanged`, no release binding, no fingerprint of tool definitions. |
| **Version fencing** | gap §0.3 | Absent. | A changed spec keeps serving the previous green badge. **Precondition for everything below.** |

What this means: the platform already *fetches* the spec, already *calls* the API, already *records* consumer traffic, and already has a *versioned* model with stable keys and a *questionnaire* channel back to the provider. It is missing the code that notices a difference, names it, publishes it, and closes the loop.

---

## 2. What the market does (September 2026)

The survey below is what a buyer would find. Sources are in Appendix A.

### 2.1 Spec-to-spec diffing is a commodity

- **oasdiff**: open source, 681 distinct checks over OpenAPI 3.0–3.2, the default CI gate for breaking changes.
- **pb33f `openapi-changes`**: open source, OpenAPI 3.2 support, walks git history ("time machine").
- **Azure `openapi-diff`**: open source, older, still used.
- **Optic** (the one tool that also inferred specs from test traffic) was acquired by Atlassian in April 2024, never integrated, and its repository was archived on 12 January 2026. There is no direct replacement for traffic-to-spec inference in the open-source space.

Conclusion: do not build a spec differ as a product. Build the diff over DocentAPI's own IR (it ties to lineage, field maps, and evidence) and borrow oasdiff's breaking-change taxonomy for the severity vocabulary.

### 2.2 Provider docs platforms do spec-driven changelogs

- **Bump.sh** ($50–250/mo): every uploaded spec release produces a changelog entry; breaking-change detection; consumers subscribe by email or RSS. Spec-only; nothing observed.
- **Mintlify Autopilot**: an agent runs on push or schedule, clones the repository, identifies which PRs need documentation changes, and drafts doc PRs for human review. That is *code → docs*. Nothing in it observes the running API.

Conclusion: the changelog-with-subscriptions pattern is proven (Bump.sh), and the "agent drafts, human approves" pattern is proven (Mintlify). Neither has an observed-behavior channel. That channel is the differentiator.

### 2.3 Provider-inward runtime conformance requires instrumenting the provider's own stack

- **SmartBear / PactFlow Drift** (March 2026): spec-derived deterministic conformance tests in the provider's CI. SmartBear explicitly frames it as a response to AI coding tools producing code that diverges from contracts.
- **Speakeasy drift detection**: SDK middleware in the provider's service flags requests not present in the schema and fires a webhook per unknown endpoint.
- **Treblle**: SDK captures production traffic, scores design-vs-runtime divergence.

Conclusion: all three sit *inside* the provider. None serves consumers or agents, none holds evidence receipts, and none can cover an API the buyer does not own. The gap analysis's provider-CI runner (§7.3) meets them on their turf later; the outside-in canary is the part they cannot do.

### 2.4 A consumer-side "third-party API monitoring" micro-category appeared in 2026

FlareCanary (free / $19 / $49), APIShift (free / $29 / $99), API Drift Alert ($149–749), DiffMon, Rumbliq, and API Detective (pre-launch: "200–500 popular public APIs against their documentation"). Mechanism in every case: poll a JSON endpoint, infer a schema, diff against a baseline, assign a severity, alert. PageCrawl and Visualping sell changelog-page watching on 15-minute polls.

Two observations. First, the category is *validated*: people pay $19–749/month for the shallow version. Second, the category is *shallow*: no semantic model, no field lineage, no reconciliation with the provider's spec or changelog, no MCP delivery, no evidence receipts, and no loop back to the provider. The comparison this survey relies on was written by FlareCanary itself, so treat its ranking as marketing and its feature list as roughly accurate.

### 2.5 MCP tool-schema drift is a live problem in the agent ecosystem

A September 2026 study fingerprinted every tool on 248 public MCP servers twice in one day (RFC 8785 canonical JSON, SHA-256): 54 descriptions rewritten, **17 input schemas or annotations changed while the description stayed byte-identical**, 9 tools added, 7 removed. Clients approve a tool once and rarely re-prompt. Bellwether, DriftCop, and Specmatic's MCP Auto-Test snapshot and diff tool lists in CI. The MCP 2026-07-28 specification added `ttlMs` and `cacheScope` hints on `tools/list` alongside the existing `listChanged` notification.

Conclusion: DocentAPI *is* an MCP server whose tool schemas are derived from spec versions. Publishing its own signed, hash-linked tool-fingerprint log per release turns an ecosystem weakness into a trust feature at almost no cost.

### 2.6 Machine-readable lifecycle signals exist and are underused

- **RFC 9745** `Deprecation` header (2025) and **RFC 8594** `Sunset` header form a two-phase lifecycle; **RFC 8288** `Link` relations point at successor versions.
- **RFC 9727** `/.well-known/api-catalog` (June 2025) locates a publisher's current specs; Fern emits it, adoption is otherwise thin.
- **OpenAPI 3.2.0** (19 September 2025), **Overlay 1.0.0** (October 2024, a standard way to express a *patch* to a spec), **Arazzo 1.1.0**.
- **Stripe** publishes near-daily tagged OpenAPI releases on GitHub (release v2274 by May 2026) and a changelog with an explicit breaking-change flag per entry. **Twilio** publishes a changelog RSS feed. **Shopify** ships quarterly versions with deprecation headers.

Conclusion: for the large providers, spec repositories and feeds *are* a machine-readable changelog. For everyone else, the lifecycle headers arrive for free on every request DocentAPI already makes. Both are currently thrown away.

### 2.7 The statistic that frames the pitch

KushoAI's *State of Agentic API Testing 2026* (1.4 million test executions across 2,616 organizations): **41% of APIs experience undocumented schema changes within 30 days** of test creation; 34% of observed failures are authentication/authorization; schema and validation errors add 22%. Caveats: it is vendor telemetry with no published methodology, and the "63% within 90 days" number circulating alongside it does **not** appear on KushoAI's page (it originates in a FlareCanary post). Cite 41%/30 days; do not cite 63%.

### 2.8 Positioning conclusion

Every tool above holds one signal for one audience. Nothing identified in this survey:

1. fuses spec diff, observed-behavior diff, announced-change extraction, lifecycle headers, and consumer-traffic anomalies;
2. reconciles them into one classified, evidence-cited change ledger;
3. serves that ledger to humans (page and changelog), agents (MCP tools with freshness), and CI;
4. closes the loop to the provider with a drafted fix and a confirmation question.

That composite is the "self-maintaining" claim. Most of its raw material is already in this repository.

---

## 3. The design: Continuous Reconciliation

### 3.1 Signal layer — seven sources, ranked by cost and fidelity

| # | Source | Trigger | Marginal cost | Fidelity | Exists? | Change needed |
|---|---|---|---|---|---|---|
| 1 | **Provider CI push** | GitHub Action on spec change | none | highest for spec | yes | Add a *deploy event* variant (spec unchanged, deploy happened → schedule canary). Compute and publish the diff on `updated`. |
| 2 | **Spec source poll** | hourly cron, all plans | near zero with conditional GET | high for spec | partial (`reverify.ts`, weekly, Business) | Store `etag` / `last_modified` on `spec_versions`; `If-None-Match`; hash compare already exists. Add a GitHub watcher for repo-hosted specs (releases and commits API, the Stripe pattern). Resolve `/.well-known/api-catalog` when present. |
| 3 | **Lifecycle headers** | every upstream response DocentAPI already receives | zero | exact, provider-asserted | no | Return response headers from `upstream`/`mcpTools`/proxy; parse `Deprecation`, `Sunset`, `Link rel=deprecation\|successor-version`, `Warning 299`, and a vendor list (`Stripe-Version`, `X-Shopify-API-Deprecated-Reason`, `X-API-Warn`, `X-API-Version`). |
| 4 | **Behavioral canary** | scheduled, per plan cadence | probe budget | high, governed | shallow (`docDrift.ts`) | Deterministic read-only fixture set per API; store an *observation snapshot* per operation; compare to the **previous snapshot** (temporal) and to the spec (conformance). Multi-sample presence statistics, not single-sample booleans. |
| 5 | **Announced changes** | crawl changelog page / RSS / GitHub releases | small | low until confirmed | no (`docsCrawler` has no classification) | Classify pages; LLM extracts *candidate* change items (subject, kind, effective date, breaking flag, quote). Each becomes a probe obligation with a due date. Never published as truth. |
| 6 | **MCP traffic anomaly** (Track A) | per-tool status/latency baseline over `mcp_calls` | zero | signal only | ledger exists, unread | A shift (200s → 4xx, latency band jump) schedules a targeted canary. Never evidence; this is demand, per gap §3. |
| 7 | **Consumer-submitted material** (Track B) | HAR / proxy capture / CI linter | — | `consumer_submitted` class | no | Later, exactly as gap §3 specifies. |

Sources 1–3 and 6 are cheap enough to run for every plan. Sources 4 and 5 are the paid dial.

### 3.2 Reconciliation layer — the part nobody else has

**Change subjects** bind to the existing model: operation (`action_key`), field path (`fieldMapFor()` path, e.g. `response.data[].amount`), auth scheme, rate-limit contract, error shape, pagination model, base URL / version, deprecation / sunset.

**Change kinds** for spec diffs borrow oasdiff's vocabulary (added, removed, type changed, required changed, enum changed, nullable changed, deprecated, response added/removed, security changed). Behavioral kinds are added: status changed, response shape changed (with presence ratio), latency band changed, rate-limit headers changed, error body shape changed, deprecation signaled, sunset scheduled.

**Severity**: `breaking | risky | additive | cosmetic`, computed by rule per kind and subject, plus a confidence carried from the sample count.

**Reconciliation states** — this matrix is the product:

| Spec | Observed behavior | State | What the system does |
|---|---|---|---|
| changed | unchanged | `spec_ahead` | Flag "documented, not yet observed." Schedule re-probe. Do not present the new shape as live. |
| unchanged | changed | `behavior_ahead` (**classic docs drift**) | Mark affected claims stale (targeted, §15.6). Draft an Overlay patch and a changelog entry. Send the provider a confirmation question. Notify watchers: "observed, undocumented." |
| changed | changed, consistent | `consistent` | Auto-publish a new release. Changelog entry. Notify affected watchers. |
| changed | changed, disagreeing | `contradictory` | Open a review item. Hold publication of the affected claims. |
| announced for date *D* | — | `announced_pending` | Affected claims get `freshUntil = D`. Canary scheduled at *D*. Watchers get an "upcoming" notice with the provider's own quote. |
| header signal | — | `deprecation_signaled` | Claim carries `deprecatedSince` / `sunsetAt`. Watchers get a countdown. |

**False-positive discipline**, because the monitoring micro-SaaS wave gets this wrong: a field absent in one sample of five is data variance, not a schema change. Every observed-behavior entry requires *N-of-M* agreement across samples and, where the platform has them, across identities and environments. A `behavior_ahead` entry is never auto-published from a single observation; it is published from a consistent series and labeled with the count.

**Targeted invalidation** follows master plan §15.6: dependency edges from claims to the subjects they rest on, so a change to `POST /transfers` does not stale the state machine for `Account`. **Version fencing** (gap §0.3) is what makes any of this auditable; it is a precondition, not a step.

### 3.3 Publication layer — "our page already knows"

1. **Change ledger** (`api_changes`): one row per classified change with subject, kind, severity, confidence, reconciliation state, before/after, the observation or spec-version IDs that support it, environment, execution class, and *how we know* (`ci_push | poll | header | canary | announced | provider_confirmed`).
2. **Per-API changelog page** at `/[slug]/changes`: the Bump.sh changelog, but evidence-cited and covering behavior, not just the spec. Also RSS and JSON feeds.
3. **Freshness on every surface**: page header and badge manifest (gap §5.5) show "last confirmed live," "N of M operations re-observed in 7 days," "K changes this month," and the release hash.
4. **MCP**: two advisor tools, `get_changes_since(release | timestamp)` and `check_freshness(operation)`; `tools/list` responses carry `ttlMs` / `cacheScope` keyed to the release; `listChanged` fires on publish for stateful-era clients (dual-era support per gap §7.4).
5. **Signed tool-fingerprint log**: canonical JSON (RFC 8785) + SHA-256 per tool per release, hash-linked, published. "Our tools never change silently" becomes a verifiable statement.
6. **Watch this API** (consumer): v1 is an email subscription with severity filter (parity with Bump.sh, free). v2 is the gap analysis's `release diff × integration profile` (§3.1): "release N+1 changed 2 of the 12 fields you depend on, one breakingly." Profiles derive first from the consumer's own MCP sessions.

### 3.4 Close-the-loop layer — provider value

1. **Drafted fix.** For every `behavior_ahead` entry: an OpenAPI **Overlay 1.0.0** document patching the spec to match observation, and a changelog entry in the provider's voice. Optional PR to the provider's spec repository through a GitHub App. This gives `TECH_IMPLEMENTATION.md` §8.5 ("OpenAPI repair bot") its trigger. The model writes prose only; the patch is generated from the diff; a human approves.
2. **Confirmation question**, reusing the clarification envelopes: *"Since 2026-09-03, `GET /payments` returns `amount` as a string; your spec says integer (5 of 5 production samples). Intended? [Yes, update the spec] [No, this is a regression] [Sandbox only]."* The answer becomes a `human_confirmed` claim at `declared` assurance and, if "yes," releases the Overlay draft.
3. **Impact preview**: "*N* integrators watch this API; *K* are affected by this change." This is the number a solutions engineer wants before a deploy and the number that sells the Team tier.

### 3.5 Safety and epistemics

- The canary is R0/R1 read-only, deterministic, budgeted, and consented. Production writes never. Sandbox writes only under an approved `CleanupContract` (gap §7.2).
- **Unclaimed and third-party APIs** (consumer watch): sources 2, 3, and 5 need no credentials and run for any API. The canary needs a credential: the watcher's own vaulted key (Team+), or the provider-CI runner. Without one, the watch is honestly labeled *spec, announcement, and header signals only*. Rate stays under published limits, `User-Agent` identifies DocentAPI, and an opt-out is honored.
- LLM outputs are candidates. Demand signals are never evidence. Every ledger row cites its support. Every row is version-fenced.
- The canary stores response samples, so gap §0.1 (secret quarantine and redaction) is a precondition, not an afterthought.

### 3.6 Anti-drift check against the original idea

The original product statement ("parse all of it, hit every endpoint, learn where each value comes from, email a questionnaire for what we cannot establish, then generate the integration") describes *building* the twin. This document describes *keeping it true*. Every mechanism above reuses that loop: the canary is "hit every endpoint" on a schedule, the confirmation question is the questionnaire pointed at observed change, the Overlay draft is "we know everything, so we can also write the patch." Nothing here displaces the centre.

---

## 4. Why this is the headline, not a feature

**For the provider (who pays):** it removes the chore nobody does (updating docs), attacks the support-cost line they already measure, hands them a changelog they never write, and tells them who is affected before they deploy. It also justifies a pricing correction: today `scheduledVerification` is Business-only. Detection should be on for every plan because freshness is the wedge; cadence, depth, alert routing, and drafted fixes are the paid dial.

**For the consumer (free, the flywheel):** a free watch on any API is the reason to route through DocentAPI's MCP server instead of raw docs. Every watcher becomes a subscriber the provider can see, which is provider-side value the provider cannot get elsewhere.

**For agents:** `check_freshness` and `get_changes_since` are capabilities no documentation site offers, and a signed tool-fingerprint log is the answer to the drift problem the agent ecosystem is currently discovering.

**Competitively:** the 2026 monitoring micro-SaaS wave proves willingness to pay for the shallow version; Bump.sh proves the changelog-with-subscribers pattern; Mintlify proves "agent drafts, human approves." Nobody combines observed behavior with any of them, and nobody serves the result to agents with evidence.

**Proposed plan dial** (a product decision, flagged as such):

| Plan | Poll | Headers | Canary | Announced | Alerts | Fix drafts |
|---|---|---|---|---|---|---|
| Free | daily | yes | weekly, ≤5 ops | no | public changelog + RSS | no |
| Pro | hourly | yes | daily, ≤25 ops | yes | email, webhook | no |
| Team | hourly | yes | daily, full | yes | + Slack, profile-based impact | Overlay drafts |
| Business | hourly | yes | hourly, full, provider-CI runner | yes | + SLA, audit | + GitHub App PRs |

The cost model in master plan §26 needs a canary unit added before this is priced.

---

## 5. Sequencing: slice S1.5, "Living twin v1"

Insert between the gap analysis's S1 (unlock built value) and S2 (Integration Release). **Preconditions:** S0 in full — §0.3 version fencing, §0.2 static/live split, §0.1 secret quarantine. Each package below is one small PR series with migration and tests, in the order given.

| # | Work package | Touches | Rough size |
|---|---|---|---|
| 1 | **IR diff engine.** `diffSpecVersions(prev, next)` over `action_key` + `fieldMapFor()` paths → typed `ChangeSet`; severity rules; write `evidence_facts kind='schema_diff'`; set `operation_stability`. Hook into `buildReimportStatements` on `updated`. | new `src/lib/changes/diff.ts`, `persist.ts` | days |
| 2 | **Change ledger + changelog page + feeds.** `api_changes` table; `/[slug]/changes`; RSS and JSON. | schema, new route, new component | days |
| 3 | **Response-header capture + lifecycle parser.** Return headers from upstream calls; parse RFC 9745 / 8594 / 8288 and the vendor list; write `lifecycle_signal` facts and ledger rows. | `upstream.ts`, `mcpTools.ts`, `proxy/route.ts`, new `src/lib/changes/lifecycle.ts` | days |
| 4 | **Spec poller for all plans.** Hourly cron; `etag` / `last_modified` on `spec_versions`; conditional GET; GitHub releases watcher for repo-hosted specs; `api-catalog` resolution. Per-API QStash schedules rather than one global sweep, to stay inside function limits. | `reverify.ts` split, schema, `vercel.json` | days |
| 5 | **Canary v1.** Replace `docDrift`'s shallow compare with per-operation observation snapshots (inferred response schema with presence counts, status, latency band, rate-limit headers); compare to previous snapshot and to spec; emit ledger rows with reconciliation state and N-of-M confidence. Cadence by plan; budgets as today. | `probes/`, new `src/lib/changes/canary.ts`, schema | 1–2 weeks |
| 6 | **Reconciliation service + targeted invalidation + provider confirmation.** State machine from §3.2; claim dependency edges; new clarification question type reusing `clarify/triage` envelopes; email. | new `src/lib/changes/reconcile.ts`, `clarify/` | 1–2 weeks |
| 7 | **MCP surfaces.** `get_changes_since`, `check_freshness`; `ttlMs` / `cacheScope` on `tools/list`; `listChanged` on publish; signed RFC 8785 tool-fingerprint log. | `mcpTools.ts`, `mcp/[id]/route.ts` | ~1 week |
| 8 | **Freshness UI + badge manifest.** | product components, `badge/[slug]` | days |
| 9 | **Watch this API (email) + demand-signal detector** over `mcp_calls` → canary trigger. | new tables, cron | ~1 week |
| 10 | **Overlay draft generator + GitHub App PR.** After 1–6 are stable. | new `src/lib/changes/overlay.ts`, GitHub App | ~1 week |

Rough total for a solo builder: five to seven weeks to a demoable v1 (packages 1–8). Packages 1–3 alone already change what the product can truthfully say on every page.

Deferred to later slices, unchanged from the gap analysis: changelog-page LLM extraction into obligations (S2+, needs the planner), integration profiles × diff (S5), Track B consumer material (S5), and provider-CI runner posting oasdiff plus observed diffs (post-S3).

---

## 6. Risks and open choices

| Risk | Mitigation |
|---|---|
| False positives from data variance, A/B tests, regional or tenant differences | N-of-M sample agreement; identity and environment scoping on every snapshot; confidence on every row; `behavior_ahead` never published from one observation |
| Canary cost and provider rate limits | Conditional GETs make polling near-free; canary cadence is the paid dial; budgets and sequential execution as `reverify` already does |
| Terms-of-service exposure when watching APIs the watcher does not own | Credential-free tier (poll, headers, announcements) for unclaimed APIs; canary only with the watcher's own key or the provider's runner; rate under published limits; identified `User-Agent`; opt-out honored |
| Canary stores response bodies | §0.1 redaction pipeline runs before persistence; snapshots keep inferred shape and presence counts, not raw values, except for whitelisted enum fields |
| LLM changelog extraction invents a change | Candidates only; promotion requires a probe confirmation or a provider answer |
| Vercel cron granularity and the 300 s function limit | Per-API QStash schedules; one bounded operation set per invocation |

**Decisions needed from the product owner:**

1. Confirm the plan dial in §4, especially turning detection on for Free.
2. Whether unclaimed public APIs receive any canary at all, or the credential-free tier only.
3. Naming for the surfaces: "Changes," "Watch," and the freshness label.
4. Whether package 10 (GitHub App PRs) is in v1 or the first follow-up.

---

## Appendix A — Sources consulted (September 2026)

- oasdiff: https://www.oasdiff.com/ and https://github.com/oasdiff/oasdiff
- pb33f openapi-changes: https://github.com/pb33f/openapi-changes
- Azure openapi-diff: https://github.com/Azure/openapi-diff
- Optic archived / Atlassian: https://dev.to/flarecanary/optic-is-dead-what-now-for-api-drift-detection-2kb8 and https://specshield.io/blog/optic-is-dead-migration-guide
- Bump.sh changes management: https://bump.sh/api-change-management/ and https://docs.bump.sh/help/changes-management/changelog/
- Mintlify Autopilot: https://www.mintlify.com/blog/autopilot
- SmartBear / PactFlow Drift: https://pactflow.io/blog/schemas-can-be-contracts/ and https://thenewstack.io/smartbear-swagger-ai-api-management/
- Speakeasy spec drift detection: https://www.speakeasy.com/blog/openapi-spec-drift-detection
- Treblle API intelligence: https://treblle.com/product/api-intelligence
- 2026 drift-tool comparison (authored by FlareCanary; vendor bias): https://dev.to/flarecanary/api-schema-drift-detection-tools-compared-2026-1ib4
- MCP tool-schema drift study (248 servers): https://github.com/GautamTalksDev/mcp-pin/blob/main/docs/findings/2026-09-03-schema-drift.md
- MCP 2026-07-28 cache hints: https://blog.modelcontextprotocol.io/posts/2026-07-28/ and https://appwrite.io/blog/post/mcp-goes-stateless-in-the-2026-07-28-specification
- RFC 9745 Deprecation header: https://www.rfc-editor.org/info/rfc9745/
- RFC 9727 api-catalog: https://datatracker.ietf.org/doc/rfc9727/ and Fern's implementation https://buildwithfern.com/learn/docs/ai-features/api-catalog
- OpenAPI 3.2.0 announcement: https://www.openapis.org/blog/2025/09/23/announcing-openapi-v3-2
- Overlay and Arazzo status: https://nordicapis.com/introduction-to-openapi-overlay-specification/ and https://www.openapis.org/arazzo-specification
- Stripe OpenAPI releases and changelog: https://github.com/stripe/openapi and https://apievangelist.com/blog/2026/05/21/stripe-through-the-lens-of-api-evangelist/
- Twilio changelog RSS: https://www.twilio.com/en-us/changelog
- Shopify versioning: https://shopify.dev/docs/api/usage/versioning
- KushoAI State of Agentic API Testing 2026: https://blog.kusho.ai/state-of-agentic-api-testing-2026/
- Postman / Akita Live Insights: https://blog.postman.com/introducing-postman-live-insights-faster-better-api-debugging/

---

## Implementation log — Living Twin v1 (2026-09-06)

Work packages A–I of §5's slice, built in this order, with the suite green after each. Baseline before: 72 test files / 1,110 tests. After: 80 files / 1,269 tests, `tsc --noEmit` clean, `next build` green with zero credentials (the CI condition).

### What shipped

| §5 package | Status | Where it lives |
|---|---|---|
| 1. IR diff engine | **Done** | `src/lib/changes/diff.ts` — 19 change kinds, 4 severities, contravariance rule; `changes/fingerprint.ts` for RFC 8785-style tool hashing |
| 2. Change ledger + changelog page + feeds | **Done** | `api_changes` table (migration `0009`), `changes/ledger.ts`, `changes/query.ts`, `/[slug]/changes`, `/[slug]/changes/feed.xml`, `/api/apis/[slug]/changes` |
| 3. Response-header capture + lifecycle parser | **Done** | `changes/lifecycle.ts` (RFC 9745 / 8594 / 8288 + vendor), `probes/lifecycle.ts`, header capture in `invokeAction` |
| 4. Spec poller for all plans | **Done** | `src/lib/specPoll.ts`, `/api/cron/poll-specs`, hourly cron in `vercel.json` |
| 5. Behavioral canary | Deferred | needs per-operation observation snapshots; `operation_stability = 'drifted'` is reserved for it |
| 6. Reconciliation service + provider confirmation | Deferred | the spec-vs-observed state matrix; the clarification loop is the delivery channel |
| 7. MCP surfaces | **Partly done** | `docentapi_check_freshness`, `docentapi_get_changes_since`, tool fingerprint. Cache hints and `listChanged` deferred |
| 8. Freshness UI + badge manifest | **Done** | `FreshnessStrip`, `ChangeList`, `/badge/[slug]/manifest.json` |
| 9. Watch this API (email) + demand signals | Deferred | |
| 10. Overlay draft generator + GitHub App PR | Deferred | |

Plus the precondition the gap analysis called item zero: **version fencing** (§0.3). Every reader of `scores` now compares the score's `spec_version_id` against the API's current one. A superseded score keeps its numbers, loses the green, turns the badge grey with `stale`, drops out of the dashboard's verified set, and becomes a re-verification candidate immediately rather than on age.

### Design corrections made during implementation

1. **The badge manifest is a sibling route, not `?format=json`.** Reading a search param makes a route dynamic, and a dynamic route cannot be purged — the SVG badge would have lost the on-demand invalidation its design depends on. `/badge/[slug]/manifest.json` is its own cached route.
2. **`runImport` gained an optional `sourceUrl`.** The poller fetches bytes itself so it can act on a 304, then imports them as text. Without carrying the URL, the new version would have lost `source_url` — dropping the API out of the poll set after one successful poll — and relative `servers` entries would have failed to resolve, inventing a base-URL change that never happened.
3. **Header dedupe is a database constraint, not a read-before-write.** A partial unique index on `(api_id, dedupe_key)` collapses the same Sunset date seen on every probe run. A read-then-insert would have raced a manual verification against the reverify cron.
4. **`operation.renamed` was missing from the kind list.** For an MCP consumer the tool identity is the tool *name*; a renamed operationId keeps its method and path but the tool the agent calls disappears. Classified breaking. Likewise `safety` becoming `destructive` removes the tool from `tools/list`, so that transition is breaking rather than risky.
5. **Action row ids are now client-generated on re-import**, so a change row written in the same batch can reference the action row it describes.
6. **Lifecycle evidence is excluded from the score explanation.** A probe run records provider announcements now; listing them under "why this API scored what it scored" would claim they moved a number they never touched.
7. **`ToolDescriptor` / `buildToolList` moved to `src/lib/toolList.ts`** and the advisor descriptors to `advisor/descriptors.ts`, to break two runtime import cycles the freshness tool would otherwise have created.
8. **`lastSpecChangeAt` compares version identity, not timestamps.** Two versions can share a timestamp, and a reverted API's current version is an old row whose date says nothing about when the revert happened.

### What is now true that was not

- A provider changing their spec is detected within the hour on a paid plan and within a day on the free one, without the provider doing anything. Detection is not a paid feature; cadence is.
- Every detected change is classified by its effect on an existing integration and stored with the spec version it landed in, the way it was found, and the before/after values.
- CI push responses carry the classified diff, so a pull request says what changed rather than only that something did.
- A conditional GET means an unchanged spec costs one 304 rather than a full download and re-parse.
- `Deprecation`, `Sunset`, `Link`, and the common vendor headers are read from responses the platform already makes, and a provider's announcement becomes a dated changelog entry.
- An agent can ask whether its cached knowledge still holds, and compare a fingerprint that covers tool schemas and annotations — not just descriptions, which is the drift MCP clients currently miss.
- A score can no longer outlive the spec version it was earned against.

### Open product decisions, unchanged

The plan dial in §4 (free daily / paid hourly is what shipped), whether unclaimed APIs get any live canary, the naming of the surfaces, and whether the GitHub App PR flow belongs in v1. Also: hourly Vercel crons require a Pro project — on Hobby, change the `poll-specs` schedule in `vercel.json` to daily.

### Runtime verification against the live database (2026-09-06)

Tests, typecheck, and a credential-free build all passed before this step, and
all three missed two defects that only a running app could surface. Both are
fixed; both now have regression coverage.

**Found by running it, not by testing it:**

1. **The product page 500'd when code ran ahead of the migration.** The
   freshness strip added a ledger read to `/[slug]`, so with `api_changes`
   absent every API page went down at once — a self-inflicted outage on the
   product's main surface during any deploy where migration lagged code. Ledger
   reads now degrade to an empty result and log the error name, matching the
   "never fail the caller for an optional integration" contract `specStore.ts`
   and `replay.ts` already follow. An empty changelog is honest: the page says
   "no changes recorded", which is exactly true when the table is not there.
   The added COLUMNS on `actions` and `spec_versions` remain a hard
   prerequisite — a column cannot be read before it exists — so **migration
   0009 must be applied before or with the deploy.**

2. **The "public" JSON changelog redirected to sign-in.** `src/proxy.ts`
   protects `/api/apis(.*)`, which swallowed the one route under that prefix
   meant to be readable without an account — the endpoint a consumer's CI polls.
   Carved out as `isPublicApiRoute`; the handler's own visibility check still
   404s a private API and still requires org membership for one.

3. **`lastCheckedAt` predated `lastSpecChangeAt` from the same poll**, because
   the poll timestamp was captured before a multi-second fetch. Stamped at write
   time now, so the freshness line cannot contradict itself.

**End-to-end proof on live data.** Migration 0009 applied cleanly (additive:
one table, seven nullable/defaulted columns). One real cron run, two APIs:

| API | Outcome |
|---|---|
| `swagger-petstore-openapi-3-0` | fetched, byte-identical → `unchanged`, poll state stamped |
| `e2e-verify-1785260299979` | upstream spec had genuinely moved → **89 breaking, 55 additive** classified and written |

The changelog page (207 KB), the RSS feed, the badge manifest, and the JSON API
all render those changes; `docentapi_check_freshness` returns the spec version,
the 30-day counts and a 26-tool fingerprint; `docentapi_get_changes_since`
filters to breaking and reports `truncated: true`. Cron auth rejects an
unauthenticated request with 401.

That is the product doing the thing this document proposed: a provider changed
their API, nobody told us, and the page, the feed, the badge and the MCP server
all knew within one poll.

### Claim audit: what the landing page said vs what the code does

The last check under "the product works whatever we are saying" is the
inverse of the usual one — not "does the code work" but "is what we say about
it true". Three places claimed a capability that does not exist:

| Where | Claimed | Reality |
|---|---|---|
| `(site)/page.tsx` lead, ch. 05 | "patches the tool definitions" | No code path mutates a stored `paramsSchema` after import |
| `(site)/page.tsx` terminal replay | "tool schema patched automatically" | `buildToolList` reads the stored schema directly and never consults drift evidence |
| `landing/posters.tsx` aria-label | "patched into the tool schema" | `operation_stability` is written by no production code path |

Corrected to describe what the product does do: catch the drift, record and
classify it, and serve it to agents. **Deliberately not built instead.**
Auto-patching a published tool schema from an observation is the exact failure
the master plan's epistemic spine exists to prevent — an unreviewed observation
silently changing what the product asserts. If tool-definition correction is
wanted, it belongs behind the review gates as a proposed patch a provider
approves, not as an automatic rewrite.

The rest of the absolute claims on that page were checked and hold: "writes are
graded statically, never executed" (the probe engine only samples `safety:
'read'` operations), "every point traces back to a recorded fact" (score
explanations are `factId`-linked, and lifecycle observations are now excluded
from that list precisely so the claim stays true), and "the mark is earned"
(the badge now also goes grey the moment its spec version is superseded).

---

## Implementation log — the behavioural canary (§5 package 5)

The piece every other change source cannot reach. Spec polling compares one
document to another; the doc-drift probe compares a response to a document.
Neither can see the failure this product is named for: **the API's behaviour
moving while its documentation stays perfectly still.** That needs a record of
what an operation returned last time.

**Shape, not body.** `changes/observation.ts` reduces a response to field
paths, JSON type names, and per-sample presence counts — nothing else. A
response body is the likeliest place in the system for customer PII or a live
token, so the body is inferred and dropped; `operation_observations.shape` has
nowhere to put a value, and a test asserts no value survives inference.

**Counting presence is what makes it quiet.** An API that returns an optional
field on four requests and omits it on the fifth has not changed. A canary that
reported that would be noise, and noise on a changelog trains people to ignore
it. So each run takes several samples, records how many contained each path,
and the diff speaks only when presence is unambiguous on both sides — and never
below `MIN_SAMPLES` on either side.

**Only successful responses build a shape.** An outage is not a contract
change. Letting a run of 500s read as "every field disappeared" is the most
obvious way a canary becomes a false alarm, so a run with no 2xx records no
snapshot and reports the operation *inconclusive* instead.

**Reads only, and structurally so.** Repeating a call is a "sample" only if the
call has no effect; repeating a write is N side effects. The sampler filters to
`safety: 'read'` before anything else, and skips any operation whose required
parameters have no example rather than guessing an identifier and shaping a 404.

Findings reuse the existing `field.*` kinds — a response field that disappeared
is a response field that disappeared, however it was found — and the ledger's
`source` column records that a probe rather than a document is the evidence.
Reconciliation against the documented shape is what finally writes
`operation_stability = 'drifted'`, the column that has been present and unused
since Phase 1.

### Verified live

Wired into the existing verification run, so it inherits the resolved
credential and the outbound budget. One forced run against the public Swagger
Petstore:

```
canary: { sampled: 0, inconclusive: 3, compared: 0, changes: 0, drifted: 0 }
```

That is the correct answer, not a disappointing one. `/store/inventory`
returned HTTP 500 and `/user/login` returned `Logged in user session: …` under
a `application/json` content type. The canary declined to build a shape from
either, and said so. The happy path — baseline, compare, classified row,
`drifted` marking — is covered end to end against real Postgres in
`canaryRun.test.ts`.

One defect the live run caught that the tests had not: the wiring dropped the
`inconclusive` list, so "the canary did not run" and "it ran and could not
conclude" collapsed into the same silent outcome — exactly the distinction the
module documents itself as preserving. Both are now reported, on the outcome
and on the cron response.

---

## Deployment note: cron cadence on Hobby

The first production deploy was rejected before it changed anything:

> Hobby accounts are limited to daily cron jobs. This cron expression
> (0 * * * *) would run more than once per day.

The schedule is therefore `0 1 * * *`, and the honest statement of what ships
is: **every API's spec is checked once a day, on every plan.** The per-plan
cadence in `pollIntervalHours()` is a minimum staleness rather than a
frequency, so it is not wrong, but nothing is polled more often than the cron
fires. Restoring hourly detection is a one-line change to `vercel.json` on a
Pro account, with no code change.

This is worth stating plainly because §4 of this document proposes hourly
polling as what a paid plan buys. On the current account that differentiator
does not exist yet.

---

## Implementation log — Executed Lineage (2026-09-08)

### Why the positioning in §2 needed correcting first

Research on 2026-09-08 found the layer §2 treats as the differentiator has
largely commoditised in the six weeks since this document was written:

- **Shape-only traffic profiling is a shipped competitor feature.** ShiftGraph
  describes itself as "built on the traffic-profiling approach, storing
  structure only with values discarded at collection" — the canary's exact
  design decision, arrived at independently.
- FlareCanary polls endpoints on a schedule and classifies changes by severity.
  PageCrawl ships an MCP server over the same idea.
- Vercel's AI SDK 7.0.19 ships `fingerprintTools` and `detectToolDrift`, which
  is what `changes/fingerprint.ts` does.
- Arazzo generation is supported by Redocly, Speakeasy, Specmatic and Bruno.
- Jentic catalogues 6,000+ APIs and 2,000+ workflows in OpenAPI/Arazzo/MCP —
  but they are **authored**, not execution-verified.

The open lane is the one thing none of them do: **publish knowledge that was
verified by executing it.** Morest (ICSE 2022) is the academic blueprint — a
producer–consumer property graph adapted at runtime from actual responses,
reporting 152–232% more successfully-requested operations than spec-only
sequence generation — and it has never been productised as published integration
knowledge. `lineage.ts` already owns the top-down half of that model.

### What shipped

Read-only chain execution: take a candidate lineage edge, call the producer,
read a real identifier out of its response, send it to the consumer, then send a
fabricated one, and record what happened. Nine modules, each landed separately:
`transient.ts`, `probes/budget.ts`, `lineagePlan.ts`, `lineageExtract.ts`,
`lineageVerdict.ts`, `probes/lineageChain.ts`, `lineageRun.ts`, migration 0012,
and the read-side change to `get_call_sequence`.

### The rule that makes it worth having

**A 2xx alone is correlation, not verification.** A soft-404 API answers 200 with
`{"error":"not found"}`; a framework that ignores an unmatched path segment
returns the collection; a handler may never read the parameter at all. Under a
naive "we sent the id and got 200" rule, all three *confirm* every edge pointed
at them — wrong ones included. That would manufacture false confidence at scale,
which is strictly worse than the honest "spec structure only" string this
replaces.

So every confirmation requires a **negative control**: the same consumer, the
same other parameters, a format-valid but fabricated value. If the control also
succeeds, the run proves nothing. `fabricateLike` mirrors the real value's shape
— uuid, hex, digits, or a validated prefix like `cus_` — because a provider that
400s a malformed id *before looking anything up* would make every control
non-2xx and every chain look discriminating, silently defeating the check.

Confirming takes one run; **refuting takes agreement across runs**, since a 404
is explained just as well by tenancy scoping, a deleted record, or a rate limit.

### The value rule, and its honest limit

`transient.ts` holds extracted identifiers in a genuinely private field.
`JSON.stringify` yields `"[transient]"`, interpolation yields `[transient]`,
spread yields only safe metadata, and a `util.inspect` hook covers logging —
which matters because Node's inspect reaches into private fields, so a bare
`console.error({ ref })` would otherwise put a live identifier in the platform
log. `unwrap()` is called in exactly two audited places.

The claim is **"zero retention in DocentAPI"**, not "zero retention": the value
still reaches the provider's own access log, attributed to the owner's key.

`lineage_executions` has zero json columns, which is strictly stronger than
`operation_observations` — jsonb *could* hold a value and is kept safe by a
careful writer; an integer cannot hold one at all. A whole-database sentinel
scan asserts it, and a second test checks `operation_observations` *does* have a
json column so the first cannot pass vacuously.

### Runtime verification against live APIs (2026-09-08)

Forced runs against both public Swagger Petstores. **Neither produced a
confirmed edge**, and both were useful.

**Petstore v3** — the chain planned correctly
(`find_pets_by_status.response[].id -> get_pet_by_id.path.petId`, high
confidence) and executed. The producer returned **HTTP 500**; so did
`/store/inventory`. The demo server was broadly degraded, while `get_pet_by_id`
answered 200. The runner made exactly **one** request, reported
`inconclusive / producer_yielded_nothing`, and neither guessed an identifier nor
spent the rest of its budget.

**Petstore v2** — the chain planned, and the runner **declined to execute it**:
that spec declares `oauth2` on `findPetsByStatus` and no credential was
supplied. Correct behaviour, and not something to work around — deliberately
sending unauthenticated requests is the auth-clarity probe's job, not a chain's.

**Rick and Morty API** — the happy path, confirmed. That provider publishes no
OpenAPI document, so the spec used was hand-written and minimal; it accurately
describes the real endpoints, and every request went to the real service. What
this verifies is the RUNNER — planning, extraction, the negative control, the
verdict — not spec import, which has its own tests.

```
planned: list_characters.response.results[].id -> get_character.path.characterId [high]
4 requests: 1 producer + 2 candidates + 1 control
  2 real ids   -> 200
  fabricated   -> 404          <- the endpoint discriminates
OUTCOME: confirmed   p50 377ms
state vocabulary: status = [Alive, Dead, unknown] across 20 records
no character data in the serialized output
```

**Three more, deliberately different in shape.** None of these providers
publishes an OAS either, so each spec was hand-written and minimal; every
request went to the real service.

| API | id type | chain | control | outcome |
|---|---|---|---|---|
| GoREST | integer | `list_users.response[].id -> get_user.path.userId` | 404 | **confirmed** (2/2, p50 535ms) |
| JSONPlaceholder | integer | `list_posts.response[].id -> get_post.path.postId` | 404 | **confirmed** (2/2, p50 329ms) |
| OpenBreweryDB | string/uuid | `list_breweries.response[].id -> get_brewerie.path.breweryId` | 404 | **confirmed** (2/2, p50 828ms) |

So **four live third-party APIs confirmed**, across integer ids, string ids and
both bare-array and enveloped list responses — a real identifier read out of one
operation's response, accepted by another, with a fabricated one rejected. That
last clause is the whole difference between a verified link and a coincidence.

### The cardinality guard, validated on real data

The state-vocabulary probe recorded `status = [Alive, Dead, unknown]` for Rick
and Morty (3 distinct across 20) and `status = [active, inactive]` for GoREST
(2 across 10). It recorded **nothing** for OpenBreweryDB — which is the result
worth keeping.

OpenBreweryDB has a field literally named `state`, and it holds **geography**:
30 distinct values across 50 records (Arizona, Bayern, Aveiro, California…).
The guard refused it, 30 x 2 >= 50. Without that rule this feature would have
published "a Brewery is one of: Arizona, Aveiro, Bayern, California…" as a
lifecycle vocabulary, which is nonsense — and it would have done so off a field
whose NAME passed every check. The cardinality test is the only thing standing
between the two cases, and a real API demonstrated it.

### Four defects the live runs caught that the tests had not

1. **A required parameter with a declared `default`/`enum` but no `example` was
   treated as unsatisfiable.** Petstore v3's `findPetsByStatus` requires
   `status`, which declares `default: "available"`. Refusing to run for want of
   an *example* threw away that API's only executable chain. Using a value the
   spec itself declares is reading the spec, not guessing.
2. **Array parameters declare their values on `items`.** Swagger 2 does this
   constantly — Petstore v2's own `findPetsByStatus` is `type: array` with
   `items.enum` and `items.default` — and looking only at the top level made
   every such producer unsatisfiable.
3. **A top-level array response was unreadable.** `find_pets_by_status` returns a
   bare array, so its producer path is `response[].id`, and the extractor
   stripped `[]` only from *non-root* segments — reporting `path_absent` on a
   perfectly good response.
4. **A failed producer was reported as `path_absent`**, blaming the API's
   response shape for what was actually an outage. Now `producer_failed`. This
   is the same distinction-collapsing defect the canary's own first live run
   exposed in itself, in a new place.

### What is deliberately not wired

Manual `/verify` does not run chains. A single BYOK run cannot satisfy the
cross-run agreement rule, so it could only ever produce inconclusive verdicts.
The scheduled path is the one that produces a cadence.
