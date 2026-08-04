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

