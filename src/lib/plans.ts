// Plan-gated feature checks, matching the live legacy-site pricing tiers
// (Free $0 / Launch $29 / Pro $79 / Team $199 / Business $499) — confirmed
// as the source of truth over the stale PRICING.md figures.
//
// All numeric limits are env-overridable constants rather than hardcoded:
// the legacy copy's exact free-tier persistent-API cap isn't fully pinned
// down yet ("unlimited public pages" refers to ephemeral imports, which
// aren't billed at all — not necessarily to permanently persisted ones), so
// whatever the product owner settles on is a config change, not a
// schema/code change.

export type Plan = 'free' | 'launch' | 'pro' | 'team' | 'business';

export type PlanLimits = {
  maxPersistentApis: number;
  mcpCallsPerDay: number;
  removeBranding: boolean;
  privateApis: boolean;
  vaultedCredentials: boolean;
  customDomain: boolean;
  seats: number;
  scheduledVerification: boolean;
  auditLogs: boolean;
  // Per-action call analytics over the mcp_calls ledger. "Pro+ dashboard" in
  // TECH_IMPLEMENTATION.md §11.
  analytics: boolean;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    maxPersistentApis: envInt('PLAN_MAX_APIS_FREE', 1),
    mcpCallsPerDay: envInt('PLAN_MCP_CALLS_FREE', 200),
    removeBranding: false,
    privateApis: false,
    vaultedCredentials: false,
    customDomain: false,
    seats: 1,
    scheduledVerification: false,
    auditLogs: false,
    analytics: false,
  },
  launch: {
    maxPersistentApis: envInt('PLAN_MAX_APIS_LAUNCH', 3),
    mcpCallsPerDay: envInt('PLAN_MCP_CALLS_LAUNCH', 2_000),
    removeBranding: false,
    privateApis: false,
    vaultedCredentials: false,
    customDomain: false,
    seats: 1,
    scheduledVerification: false,
    auditLogs: false,
    analytics: false,
  },
  pro: {
    maxPersistentApis: envInt('PLAN_MAX_APIS_PRO', 10),
    mcpCallsPerDay: envInt('PLAN_MCP_CALLS_PRO', 10_000),
    removeBranding: true,
    privateApis: false,
    vaultedCredentials: false,
    customDomain: false,
    seats: 1,
    scheduledVerification: false,
    auditLogs: false,
    analytics: true,
  },
  team: {
    maxPersistentApis: envInt('PLAN_MAX_APIS_TEAM', 25),
    mcpCallsPerDay: envInt('PLAN_MCP_CALLS_TEAM', 50_000),
    removeBranding: true,
    privateApis: true,
    vaultedCredentials: true,
    customDomain: true,
    seats: envInt('PLAN_SEATS_TEAM', 5),
    scheduledVerification: false,
    auditLogs: false,
    analytics: true,
  },
  business: {
    maxPersistentApis: envInt('PLAN_MAX_APIS_BUSINESS', 100),
    mcpCallsPerDay: envInt('PLAN_MCP_CALLS_BUSINESS', 250_000),
    removeBranding: true,
    privateApis: true,
    vaultedCredentials: true,
    customDomain: true,
    seats: envInt('PLAN_SEATS_BUSINESS', 20),
    scheduledVerification: true,
    auditLogs: true,
    analytics: true,
  },
};

export function limitsFor(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as Plan] ?? PLAN_LIMITS.free;
}

type BoolFeature = Exclude<
  { [K in keyof PlanLimits]: PlanLimits[K] extends boolean ? K : never }[keyof PlanLimits],
  never
>;

export function can(plan: string, feature: BoolFeature): boolean {
  return limitsFor(plan)[feature];
}
