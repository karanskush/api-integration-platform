# TrueAPI — Pricing & Cost Analysis

> **Status:** Pre-launch pricing model
> **Date:** 2026-05-19
> **Pricing unit:** Endpoints (the honest, scalable unit)

---

## 1. Why endpoints as the pricing unit

"Per API" is fuzzy — is Stripe Payments one API or fifty? Endpoints are
unambiguous: they're in the OpenAPI spec, they map directly to our cost
(more endpoints = more probes = more compute + LLM inference), and the
provider already knows their count.

---

## 2. Our cost to serve

### Per-endpoint economics

| Cost Component | Per Endpoint/Month | Notes |
|----------------|-------------------|-------|
| Probing compute (Cloudflare Workers) | ~$0.05 | ~10K probe requests/endpoint/month |
| LLM semantic layer (Haiku 4.5 batch) | ~$0.01 | ~1K tokens/endpoint, amortized |
| Model storage (Cloudflare R2/D1) | ~$0.01 | <10KB per endpoint behavioral model |
| MCP serving (CF Workers) | ~$0.03/10K requests | Scales with consumer usage |
| **Total marginal cost per endpoint** | **~$0.10/month** | At moderate usage |

### Fixed infrastructure costs

| Component | Monthly Cost | Notes |
|-----------|-------------|-------|
| Cloudflare Workers paid plan | $5 | Base fee, covers 10M requests |
| Fly.io (dashboard + probe orchestrator) | $8 | Shared-cpu VM |
| Domain + DNS | $2 | Cloudflare |
| Monitoring / logging | $0 | Free tiers (Grafana Cloud, etc.) |
| **Total fixed cost** | **~$15/month** | Stays flat until significant scale |

### Cost at scale

| Scenario | Endpoints | Monthly Infra Cost | Notes |
|----------|-----------|-------------------|-------|
| 10 customers, ~200 endpoints | 200 | ~$35 | Mostly fixed costs |
| 50 customers, ~1,500 endpoints | 1,500 | ~$165 | Marginal cost dominates |
| 200 customers, ~8,000 endpoints | 8,000 | ~$815 | Still under $1K |
| 500 customers, ~25,000 endpoints | 25,000 | ~$2,515 | CF Workers scales linearly |

---

## 3. Pricing tiers

### Free — $0/month (forever)

- Up to **10 endpoints**
- L2 behavioral model (all 7 knowledge layers)
- Hosted MCP server (10K requests/day)
- Web explorer (read-only, for consumers)
- Monthly re-probing
- Community support

**Why free:** This IS the distribution strategy. A developer onboards their
small API, sees the behavioral model catch things their docs missed, shows
their team. Costs us ~$1/month per free user. The MCP server generates
flywheel data. Free users build the moat.

**Who it's for:** Solo devs, side-project APIs, internal tools with a few
endpoints, anyone evaluating TrueAPI before committing.

---

### Pro — $49/month

- Up to **50 endpoints**
- 100K MCP requests/day
- Weekly re-probing
- Drift alerts (email)
- Dashboard for provider review & correction
- Email support

**Why $49:** Cheaper than a team lunch. A typical early-stage fintech API
has 15–40 endpoints — fits perfectly. If it saves ONE support ticket per
week (2 hours of SE time = $130), that's 2.6x ROI immediately. A developer
can expense this without asking their manager.

**Who it's for:** Startup with one focused API product. Series A fintech
with a payments or data API.

---

### Team — $149/month

- Up to **150 endpoints**
- 500K MCP requests/day
- Daily re-probing + drift alerts
- Sandbox–production divergence map
- Webhook contract monitoring
- Slack support

**Why $149:** Less than one day of a Solutions Engineer's time ($650/day).
Covers a growing API platform with multiple resource types. The divergence
map alone prevents production launch-day surprises worth thousands.

**Who it's for:** Growing API companies with multiple products or resource
domains. Series B fintech scaling their integration partner base.

---

### Business — $399/month

- Up to **500 endpoints**
- Unlimited MCP requests
- Hourly re-probing + real-time drift alerts
- Cross-provider correlation maps
- Integration analytics (which consumers hit which errors)
- Priority support + dedicated Slack channel
- SSO

**Why $399:** A mid-market API company paying $399/month instead of hiring
a $13,500/month Solutions Engineer is getting a 97% discount on the same
outcome. Even at 500 endpoints, our cost is ~$65/month — healthy margins.

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

**Why custom:** Only for companies that need compliance, security, or
on-prem requirements. Don't overcomplicate — most revenue comes from
Pro and Team.

**Who it's for:** Large fintech platforms, banks, regulated industries
where data residency and audit trails are non-negotiable.

---

## 4. Revenue projections (12 months post-launch)

### Conservative scenario

| Tier | Customers | MRR |
|------|-----------|-----|
| Free | 200 | $0 |
| Pro ($49) | 80 | $3,920 |
| Team ($149) | 25 | $3,725 |
| Business ($399) | 8 | $3,192 |
| Enterprise (~$999) | 2 | $1,998 |
| **Total** | **315** | **$12,835** |

### Costs at that scale (~4,500 paid endpoints)

| Cost | Monthly |
|------|---------|
| Cloudflare (Workers + R2 + D1) | ~$200 |
| LLM inference (Haiku batch) | ~$50 |
| Fly.io (dashboard + orchestrator) | ~$30 |
| Domain + misc | ~$20 |
| **Total infra** | **~$300** |

**Monthly profit: ~$12,500. Annual: ~$150,000.**
**Gross margin: 97.7%.**

Infrastructure cost barely scales — going from 315 to 1,000 customers
roughly doubles infra to ~$600/month while tripling+ revenue.

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

Mid-market providers with 10–15 people across these roles spend
$1.5M–$2.5M/year on integration support.

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
| **TrueAPI Pro** | $49/mo | Behavior-verified model, 50 endpoints, hosted MCP |
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

- **Free:** "See what your docs are getting wrong. Costs nothing."
- **Pro ($49):** "Cheaper than the support ticket your customer files this week."
- **Team ($149):** "Less than one day of your Solutions Engineer's time. Covers the whole API."
- **Business ($399):** "97% cheaper than the SE hire you're about to make."

---

## 8. Future add-ons (not at launch — build after PMF)

| Add-On | Price | Value |
|--------|-------|-------|
| Drift monitoring (real-time behavioral change detection) | $29/mo | Alert before customers notice |
| Integration analytics (consumer error patterns) | $49/mo | Product insight for providers |
| Onboarding linter (verify consumer calls against L2) | $79/mo | Proactive error prevention |
| Custom probe sets (specific scenarios to verify) | $19/probe-set | On-demand QA |

Keep add-ons cheap. They're expansion revenue, not the core business.

---

## 9. Pricing principles (for future decisions)

1. **A developer should be able to pay without asking their manager.** Pro at
   $49 clears this bar at every company.
2. **Anchor against headcount, not software.** We're replacing hours of human
   back-and-forth, not competing with other dev tools.
3. **Free tier is not charity — it's distribution.** Every free MCP server is
   a consumer telling the next provider "why don't you have this?"
4. **Endpoints are the honest unit.** They map to our cost, the provider
   knows their count, and there's no ambiguity.
5. **Don't punish usage.** MCP request limits should be generous. Every
   request makes L2 better (flywheel). Restricting usage restricts learning.
6. **Keep it simple.** Four tiers + enterprise. No per-seat multipliers, no
   overage calculators, no "contact us for pricing" on the main tiers.

---

## Sources

- Cloudflare Workers pricing (2026)
- AWS Lambda pricing (2026)
- Fly.io pricing (2026)
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
