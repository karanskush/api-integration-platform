# TrueAPI — Pricing & Cost Analysis

> **Status:** Live pricing (matches `site/index.html`)
> **Date:** 2026-05-22
> **Pricing unit:** Endpoints (the honest, scalable unit)

---

## 1. Why endpoints as the pricing unit

"Per API" is fuzzy — is Stripe Payments one API or fifty? Endpoints are
unambiguous: they're in the OpenAPI spec, the provider already knows their count,
and there's no per-seat tax or usage cliff to reason about.

One nuance (see §2): endpoints are the *billing* unit, but they are a packaging
proxy, not our true cost driver. We bill on endpoints because it's legible;
our cost is actually set by re-modeling events and MCP request volume — which is
exactly what the tiers gate.

---

## 2. Our cost to serve

### The two real cost drivers

Endpoint count loosely correlates with onboarding cost (more endpoints = more to
probe + more tokens to model), but ongoing cost is dominated by two things:

1. **Re-modeling events (probe + LLM analysis).** Front-loaded at onboarding: one
   full probe across all endpoints plus a batched Claude Haiku semantic pass.
   Re-probing afterward is a cheap *structural diff* — the expensive LLM pass only
   re-runs on the endpoints that actually drifted. So cost is large once, small
   forever after.
2. **MCP request volume (serving).** Pure denormalized DB reads — no LLM in the
   request path (see `ARCHITECTURE_2026-05-20.md` decision 6b). Fractions of a cent
   per thousand requests on Vercel + Neon.

The tiers gate **re-probe cadence** and **MCP volume** because those are what cost
us — not the raw endpoint number.

### Marginal cost per customer

| Component | Cost | Notes |
|-----------|------|-------|
| Onboarding (one-time) | ~$0.50–1.00 | Haiku batch over the spec + initial probe compute |
| Ongoing (per month) | ~$1–3 | Re-probe diffs + occasional drift LLM + MCP serving |

### Fixed infrastructure costs (current stack)

| Component | Monthly Cost | Notes |
|-----------|-------------|-------|
| Vercel (Fluid Compute, Pro) | ~$20 | Dashboard + MCP endpoints + probe orchestration |
| Neon Postgres (always-on) | ~$19 | Always-on compute keeps MCP reads <200ms p95 |
| Domain + DNS | ~$2 | — |
| Clerk auth | $0 | Free tier at this scale |
| **Total fixed cost** | **~$40/month** | Flat until meaningful scale |

### Gross margin

A $49 Pro customer costs us ~$3–4/month all-in → **~92% gross margin.** Margin
*improves* with scale as the ~$40 fixed base amortizes across more customers. The
binding constraint at our scale is **support headcount, not infrastructure** —
which is why onboarding stays self-serve and the model self-corrects via the
flywheel.

---

## 3. Pricing tiers

Five self-serve tiers + Enterprise. Endpoint caps are the billing unit; re-probe
cadence and MCP volume are what scale with the price.

### Free — $0/month (forever for open-source & public APIs)

- Up to **25 endpoints**
- **All 7 knowledge layers**
- Hosted MCP server (**25K requests/day**)
- Monthly re-probing
- Community support

**Why free:** This IS the distribution strategy. A developer onboards their API,
sees the behavioral model catch what their docs missed, shows their team. Costs us
~$1/month. Every free MCP server is a consumer telling the next provider "why don't
you have this?" Free users build the moat.

**Who it's for:** Open-source maintainers, public APIs, solo devs, anyone
evaluating TrueAPI before committing.

---

### Starter — $25/month

- Up to **50 endpoints**
- **100K MCP requests/day**
- Weekly re-probing
- Drift alerts
- Email support

**Why $25:** Less than a coffee a week. Removes the jump from $0 to $49 so an indie
dev shipping a real API has an obvious next step. Pure adoption tier — at ~$2/month
cost to serve, it's still ~92% margin.

**Who it's for:** Indie devs and side projects that have outgrown the Free endpoint
cap but aren't a funded startup yet.

---

### Pro — $49/month  *(most popular)*

- Up to **150 endpoints**
- **250K MCP requests/day**
- Weekly re-probing + drift alerts
- **Provider Dashboard** (review & correct the L2 model)
- Email support

**Why $49:** Cheaper than a team lunch. A typical early-stage fintech API has
15–40 endpoints — fits with headroom. If it saves ONE support ticket per week
(~2 hours of SE time ≈ $130), that's immediate ROI. A developer can expense this
without asking their manager.

**Who it's for:** Startup with one focused API product. Series A fintech with a
payments or data API.

---

### Team — $149/month

- Up to **400 endpoints**
- **1M MCP requests/day**
- Daily re-probing + drift alerts
- Sandbox–production divergence map
- Webhook contract monitoring
- Slack support

**Why $149:** Less than one day of a Solutions Engineer's time (~$650/day). Covers
a growing API platform with multiple resource types. The divergence map alone
prevents production launch-day surprises worth thousands.

**Who it's for:** Growing API companies with multiple products or resource domains.
Series B fintech scaling their integration partner base.

---

### Business — $399/month

- Up to **1,000 endpoints**
- **Fair-use MCP (5M requests/day)**
- Hourly re-probing + real-time drift alerts
- Cross-provider correlation maps
- Integration analytics (which consumers hit which errors)
- **SSO** + priority support (dedicated Slack channel)

**Why $399:** A mid-market API company paying $399/month instead of hiring a
~$13,500/month Solutions Engineer is getting a ~97% discount on the same outcome.
Even at 1,000 endpoints and 5M MCP requests/day, our cost is a few dollars/month —
healthy margins.

**Who it's for:** Multi-product API platforms. Payment orchestrators.
Banking-as-a-service providers with broad endpoint surface.

---

### Enterprise — Custom (starting ~$999/month)

- Unlimited endpoints
- Everything in Business
- Self-hosted / VPC deployment option
- Traffic-mirroring integration (production fidelity tier)
- SLA (99.9% MCP uptime)
- Audit logs, RBAC
- Dedicated support engineer

**Why custom:** Only for companies that need compliance, security, or on-prem
requirements. Don't overcomplicate — most revenue comes from Pro and Team.

**Who it's for:** Large fintech platforms, banks, regulated industries where data
residency and audit trails are non-negotiable.

---

## 4. Revenue projections (12 months post-launch)

### Conservative scenario

| Tier | Customers | MRR |
|------|-----------|-----|
| Free | 300 | $0 |
| Starter ($25) | 120 | $3,000 |
| Pro ($49) | 80 | $3,920 |
| Team ($149) | 25 | $3,725 |
| Business ($399) | 8 | $3,192 |
| Enterprise (~$999) | 2 | $1,998 |
| **Total** | **535** | **$15,835** |

### Costs at that scale

| Cost | Monthly |
|------|---------|
| Fixed infra (Vercel + Neon + domain) | ~$40 |
| Marginal — paid customers (~235 × ~$2.5) | ~$590 |
| Marginal — free users (300 × ~$1) | ~$300 |
| **Total infra** | **~$950** |

**Monthly profit: ~$14,900. Annual: ~$179,000.**
**Gross margin: ~94%.**

Infrastructure barely scales — going from 535 to ~1,500 customers roughly doubles
infra while tripling+ revenue. The real cost of growth is **support headcount**, not
servers, which is why the self-serve + flywheel model matters.

---

## 5. What the provider currently pays (our selling context)

### Their support stack cost

| Role | Headcount | Annual Loaded Cost |
|------|-----------|-------------------|
| Solutions Engineers | 2 | $324,000 |
| Developer Advocates | 1 | $135,000 |
| Technical Writer | 1 | $133,000 |
| Technical Support Engineers | 2 | $268,000 |
| **Total** | **6 people** | **$860,000/year** |

Mid-market providers with 10–15 people across these roles spend $1.5M–$2.5M/year on
integration support.

### Their customer's integration cost

| Cost | Amount |
|------|--------|
| Engineer time to build one integration | 150 hours (~$10,800) |
| Annual maintenance per integration | 300 hours (~$21,600) |
| Support tickets per integration/year | 150 tickets (~$15,900) |
| **Total per integration** | **~$48,000/year** |

### Revenue delayed by slow integrations

- Average enterprise API contract: $50K–$500K/year
- Each week of integration delay = ~$1,000–$10,000 delayed revenue
- Across 50 new customers/year with 4 weeks avoidable delay:
  **$200K–$2M in delayed annual revenue**

---

## 6. Price comparison — why we win

| Product | Price | What You Get |
|---------|-------|-------------|
| **TrueAPI Pro** | $49/mo | Behavior-verified model, 150 endpoints, hosted MCP |
| **TrueAPI Starter** | $25/mo | Behavior-verified model, 50 endpoints, hosted MCP |
| Postman Team | $19/user/mo ($57 for 3) | Static spec viewer, no behavioral verification |
| ReadMe Pro | $250/mo | Pretty docs, still just the spec |
| Speakeasy | $720/mo/language | SDK generation from spec (encodes spec bugs into code) |
| Stoplight Startup | $113/mo | Design + mock server (mocks the spec, not reality) |
| Treblle Core | $233/mo | API observability, no behavioral model |
| One SE support ticket | ~$130 | 2 hours of a human answering one question |
| One failed integration | ~$10,800 | 150 hours of wasted engineer time |
| One Solutions Engineer | $13,500/mo | The person TrueAPI partially replaces |

---

## 7. The ROI one-liner for each tier

- **Free:** "See what your docs are getting wrong. Free forever for open-source."
- **Starter ($25):** "Less than a coffee a week to know how your API really behaves."
- **Pro ($49):** "Cheaper than the support ticket your customer files this week."
- **Team ($149):** "Less than one day of your Solutions Engineer's time."
- **Business ($399):** "97% cheaper than the SE hire you're sizing up."

---

## 8. Future add-ons (not at launch — build after PMF)

| Add-On | Price | Value |
|--------|-------|-------|
| Onboarding linter (verify consumer calls against L2) | $79/mo | Proactive error prevention |
| Custom probe sets (specific scenarios to verify) | $19/probe-set | On-demand QA |
| Cross-provider correlation packs | Enterprise | Multi-API identity mapping |
| Traffic-mirroring fidelity feed | Enterprise | Production-grade failure data |

Drift alerts and sandbox/prod divergence are **bundled into the tiers** (Starter+
and Team+ respectively), not add-ons. Keep any future add-ons cheap — they're
expansion revenue, not the core business.

---

## 9. Pricing principles (for future decisions)

1. **A developer should be able to pay without asking their manager.** Pro at $49
   clears this bar at every company; Starter at $25 clears it for indies.
2. **Anchor against headcount, not software.** We're replacing hours of human
   back-and-forth, not competing with other dev tools.
3. **Free tier is not charity — it's distribution.** Every free MCP server is a
   consumer telling the next provider "why don't you have this?"
4. **Endpoints are the billing unit; re-modeling events + MCP volume are the true
   cost drivers.** Tiers gate cadence and volume because that's what actually costs
   us — endpoint count is just the legible packaging proxy.
5. **Don't punish usage.** MCP request limits should be generous. Every request
   makes L2 better (flywheel). Restricting usage restricts learning.
6. **The binding constraint is support headcount, not infra.** Keep onboarding
   self-serve and the model self-correcting so growth doesn't require hiring.
7. **Keep it simple.** Five tiers + Enterprise. No per-seat multipliers, no overage
   calculators, no "contact us" on the main tiers.

---

## Sources

- Vercel Fluid Compute pricing (2026)
- Neon Postgres pricing (2026)
- Anthropic Claude API pricing (Haiku 4.5, Sonnet 4.6, Opus 4.7)
- Postman pricing page (2026)
- Speakeasy pricing page (2026)
- ReadMe pricing page (2026)
- Stoplight pricing page (2026)
- Treblle pricing page (2026)
- Glama MCP hosting pricing (2026)
- Talent.com salary data (Solutions Engineer, Developer Advocate, 2026)
- Merge.dev: "Cost of API Integrations"
- Postman State of API Report 2024
- Lunar.dev 2024 API Consumer Report
