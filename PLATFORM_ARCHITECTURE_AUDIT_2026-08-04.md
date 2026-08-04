# DocentAPI architecture audit: from API documentation to a verified behavioral twin

Date: 2026-08-04  
Scope: repository implementation, product architecture, active verification, evidence, security, standards, competitive position, and build order.

## Executive verdict

The idea is larger and more valuable than “better API documentation.” The strongest version of DocentAPI is a **governed, continuously verified behavioral twin of an API**: a system that knows what an API declares, what it has actually observed, what depends on tenant/role/environment/state, what remains unknown, and which operations an agent may safely perform.

The repository already contains a credible first product:

- OpenAPI/Swagger/Postman/cURL ingestion with safe URL fetching;
- a compact endpoint IR, field maps, inferred value lineage, documentation crawling, and LLM enrichment;
- a human clarification loop with signed email completion links;
- public/private API pages, playground execution, code snippets, a grounded Q&A surface, and hosted MCP;
- versioned specs, evidence facts, scores, credentials, credential audit, analysis runs, and generated Arazzo/enriched-spec artifacts;
- SSRF protection, request validation, limits, Clerk tenancy, billing, QStash jobs, Redis rate limits, and encrypted credential storage.

That is substantially more than a mock-up. But the central promise is not implemented yet. Today the platform has:

1. a **static compiler** from a spec into an integration surface;
2. a **semantic enrichment pass** that infers field meaning and asks narrow questions;
3. a **small live-score sampler** that makes a few read-oriented requests.

It does not yet have the third engine the thesis requires: a durable, policy-controlled experimental runtime that creates fixtures, chains dependent calls, varies one condition at a time, observes state over time, correlates webhooks/events, cleans up, reproduces results, and promotes observations into scoped behavioral claims.

The most important near-term decision is therefore:

> Build the evidence-producing experiment engine before expanding the generated documentation or “MVP builder.”

The market already has strong spec-to-docs, spec-to-SDK, spec-to-MCP, testing, catalog, and agent products. DocentAPI’s defensible layer is **behavioral truth with provenance and an explicit unknown set**.

## 1. The promise to make—and the promise not to make

### Recommended product promise

For a specific API version, environment, tenant, credential role, and intended outcome, DocentAPI can:

- produce the safest known call plan;
- explain where every required value comes from;
- distinguish provider-declared behavior from observed behavior and human confirmation;
- show the evidence, scope, age, and reproducibility of each claim;
- identify exactly what it does not yet know;
- execute or rehearse an approved workflow within a declared safety and cost budget;
- detect drift and retract stale claims.

### Why “every value a parameter can take” is not literally discoverable

Many API value domains are open-ended or contextual: customer IDs come from a tenant’s data, a status can depend on a prior transition, an amount can be bounded by account configuration, and an OAuth scope can expose a different schema. Sampling can never establish that an unbounded set is complete.

Every field therefore needs a typed `ValueDomain`, not merely examples:

| Domain kind | Meaning | Example |
|---|---|---|
| `exact` | Complete, enumerable domain | enum, boolean, const |
| `constrained` | Infinite/large domain with known rules | integer 1–100, regex, date-time |
| `relational` | Must reference another resource or prior output | `customer_id` from `create_customer.id` |
| `derived` | Computed from other inputs or external state | signature, checksum, cursor |
| `provider_declared` | Human/provider says the rule, not yet observed | account-specific limit |
| `sampled` | Values observed in finite runs; never exhaustive by default | three error codes seen in 40 runs |
| `unknown` | Evidence is insufficient | undocumented opaque string |

Each domain also needs `completeness = exhaustive | partial | unknown`, its scope, evidence, and last verification time. A sampled set must never silently become an enum.

## 2. What is built today

### 2.1 Ingestion and normalization

The import path accepts OpenAPI 3, converts Swagger 2, converts Postman collections, and can form an operation from cURL. External `$ref` fetching is deliberately disabled, which is a good initial SSRF posture ([parser](./src/lib/importer/openapi.ts#L10)). The stored source is versioned by a content hash and can point to the raw snapshot ([schema](./src/lib/db/schema.ts#L96)).

The current IR is intentionally small: one dominant auth type, path/query/header/body parameters, one selected request media type, one selected 2xx JSON response schema, one selected 4xx JSON error schema, examples, and a `read | write | destructive` label ([IR](./src/lib/ir.ts#L7), [normalizer](./src/lib/normalize.ts#L285)). It caps an import at 300 operations ([IR](./src/lib/ir.ts#L62)).

That makes the UI and MCP compiler simple, but it is too lossy to be the source of truth for behavioral ownership.

### 2.2 Structural and semantic knowledge

The platform flattens request/response fields, infers resource relationships, and records lineage facts. It then crawls a bounded set of provider documentation pages—five seeds, twenty pages, 2 MB, depth two—and sends bounded field/resource chunks to an LLM ([crawler](./src/lib/docsCrawler.ts#L34), [enrichment](./src/lib/deepEnrich.ts#L87)). The enrichment code is unusually careful about prompt injection, hallucinated fields, disputed lineage, and preferring an open question over a guess.

The clarification system is also well conceived: questions are clustered across repeated fields, can be supported or reopened, and human answers become higher-trust evidence. This is an important foundation, not throwaway work.

