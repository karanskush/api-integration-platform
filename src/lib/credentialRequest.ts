// The credentials route's request shapes, validated in one pure place so the
// rules are unit-tested and the route stays a thin caller. Nothing here touches
// the database, and nothing here returns any part of the secret.

import { inferEnvironment, looksLive, type EnvironmentInference } from './credentialInference';
import { CREDENTIAL_ENVIRONMENTS, type CredentialEnvironment } from './vaultStore';

const MAX_SECRET_BYTES = 8 * 1024;
const MAX_LABEL_CHARS = 60;

// C0 controls, DEL and the C1 range — built without escape literals so the
// source itself never contains a control character.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`,
  'g',
);

export type CredentialPost = {
  secret: string;
  environment: CredentialEnvironment;
  label: string | null;
  writeConsent: boolean;
  burstConsent: boolean;
  inferred: EnvironmentInference;
  /** Set when the owner stores a production credential that looks like a test key. */
  warning: string | null;
};

export type ParseFailure = { ok: false; error: string; status: 400 };

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Control characters out, length bounded — this is rendered back to the owner.
  const cleaned = value.replace(CONTROL_CHARS, '').trim();
  return cleaned ? cleaned.slice(0, MAX_LABEL_CHARS) : null;
}

function parseEnvironment(value: unknown): CredentialEnvironment | null {
  const env = typeof value === 'string' ? value.trim().toLowerCase() : 'production';
  return (CREDENTIAL_ENVIRONMENTS as readonly string[]).includes(env) ? (env as CredentialEnvironment) : null;
}

export function parseCredentialPost(
  body: unknown,
  ctx: { baseUrls?: string[]; declaredTestPrefix?: string | null; declaredSandboxBaseUrl?: string | null } = {},
): { ok: true; value: CredentialPost } | ParseFailure {
  const fail = (error: string): ParseFailure => ({ ok: false, error, status: 400 });
  if (typeof body !== 'object' || body === null) return fail('Invalid JSON body');
  const b = body as Record<string, unknown>;

  const secret = typeof b.secret === 'string' ? b.secret.trim() : '';
  if (!secret) return fail('secret is required');
  if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) return fail('secret is too long');

  const environment = parseEnvironment(b.environment);
  if (!environment) return fail(`environment must be one of: ${CREDENTIAL_ENVIRONMENTS.join(', ')}`);

  const writeConsent = b.writeConsent === true;
  const burstConsent = b.burstConsent === true;
  const inferred = inferEnvironment(secret, ctx);

  if (environment === 'sandbox') {
    if (b.confirmedNoRealData !== true) {
      return fail('Confirm this key has no real customers, money or messages behind it.');
    }
    // The one hard rule: a key with a recognised LIVE prefix is never stored as
    // sandbox, and there is no override — the point is to make the mistake
    // impossible rather than merely warned about.
    if (looksLive(secret)) {
      return fail('This looks like a live key (a _live_ prefix). Sandbox credentials must be test keys.');
    }
  } else if (writeConsent || burstConsent) {
    return fail('Write and burst consent apply to sandbox credentials only.');
  }

  const warning =
    environment === 'production' && inferred.environment === 'sandbox'
      ? 'This key looks like a test key but is being stored as production. Probes will treat every finding as production truth.'
      : null;

  return {
    ok: true,
    value: { secret, environment, label: cleanLabel(b.label), writeConsent, burstConsent, inferred, warning },
  };
}

export type ConsentPatch = { label?: string | null; writeConsent?: boolean; burstConsent?: boolean };

export function parseConsentPatch(body: unknown): { ok: true; value: ConsentPatch } | ParseFailure {
  const fail = (error: string): ParseFailure => ({ ok: false, error, status: 400 });
  if (typeof body !== 'object' || body === null) return fail('Invalid JSON body');
  const b = body as Record<string, unknown>;
  const value: ConsentPatch = {};
  if ('label' in b) value.label = cleanLabel(b.label);
  if ('writeConsent' in b) {
    if (typeof b.writeConsent !== 'boolean') return fail('writeConsent must be a boolean');
    value.writeConsent = b.writeConsent;
  }
  if ('burstConsent' in b) {
    if (typeof b.burstConsent !== 'boolean') return fail('burstConsent must be a boolean');
    value.burstConsent = b.burstConsent;
  }
  if (Object.keys(value).length === 0) return fail('Nothing to change: send label, writeConsent or burstConsent.');
  return { ok: true, value };
}
