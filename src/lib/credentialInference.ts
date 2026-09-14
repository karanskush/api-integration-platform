// What a key LOOKS like: sandbox, production, or no idea.
//
// Providers that separate environments usually say so in the key itself
// (Stripe's `sk_test_` / `sk_live_`) or in the host (`api.sandbox.example.com`).
// This reads those signals to warn an owner who is about to store a live key as
// a sandbox credential, and to record on the row what the key looked like. It
// decides nothing on its own: the owner's declared environment is what the
// vault stores, and the one hard rule — a key with a recognised LIVE prefix can
// never be stored as sandbox — is applied by the route, not here.
//
// Pure, and the return value never contains any part of the secret.

export type InferredEnvironment = 'sandbox' | 'production' | 'unknown';
export type InferenceBasis = 'known_prefix' | 'declared_prefix' | 'host' | 'none';

export type EnvironmentInference = { environment: InferredEnvironment; basis: InferenceBasis };

// Vendor conventions we recognise. Deliberately short: a wrong guess here is
// worse than none, because the owner will trust it.
const SANDBOX_PREFIXES = ['sk_test_', 'pk_test_', 'rk_test_', 'whsec_test_', 'sk-test-', 'test_', 'sandbox_', 'sb_'];
const LIVE_PREFIXES = ['sk_live_', 'pk_live_', 'rk_live_', 'whsec_live_', 'sk-live-', 'live_'];
const SANDBOX_HOST = /(^|\.)(sandbox|test|testing|staging|dev)([.-]|$)/i;
const SANDBOX_HOST_SUFFIX = /-(sandbox|test|staging)\./i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function inferEnvironment(
  secret: string,
  opts: { declaredTestPrefix?: string | null; baseUrls?: string[]; declaredSandboxBaseUrl?: string | null } = {},
): EnvironmentInference {
  const key = secret.trim();
  const lower = key.toLowerCase();

  const declared = opts.declaredTestPrefix?.trim();
  if (declared && lower.startsWith(declared.toLowerCase())) return { environment: 'sandbox', basis: 'declared_prefix' };

  if (LIVE_PREFIXES.some((p) => lower.startsWith(p))) return { environment: 'production', basis: 'known_prefix' };
  if (SANDBOX_PREFIXES.some((p) => lower.startsWith(p))) return { environment: 'sandbox', basis: 'known_prefix' };

  if (opts.declaredSandboxBaseUrl) return { environment: 'sandbox', basis: 'host' };
  for (const url of opts.baseUrls ?? []) {
    const host = hostOf(url);
    if (host && (SANDBOX_HOST.test(host) || SANDBOX_HOST_SUFFIX.test(host))) return { environment: 'sandbox', basis: 'host' };
  }

  return { environment: 'unknown', basis: 'none' };
}

/** True when the key carries a prefix this module recognises as LIVE. The route refuses to store such a key as sandbox. */
export function looksLive(secret: string): boolean {
  const lower = secret.trim().toLowerCase();
  return LIVE_PREFIXES.some((p) => lower.startsWith(p));
}

/** A one-line hint for the UI, never echoing the key. */
export function describeInference(inference: EnvironmentInference): string {
  switch (inference.basis) {
    case 'declared_prefix':
      return 'Matches the test-key prefix you declared for this API.';
    case 'known_prefix':
      return inference.environment === 'production'
        ? 'Looks like a LIVE key — it cannot be stored as a sandbox credential.'
        : 'Looks like a test key.';
    case 'host':
      return 'This API is served from a sandbox-looking host.';
    default:
      return 'No recognised prefix; we will trust your selection and label every finding as sandbox.';
  }
}
