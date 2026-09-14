// Which key a probe run uses, and therefore which environment its facts belong to.
//
// Three sources, in a fixed order:
//
//   1. a key the caller pasted for this run (BYOK) — used once, never stored,
//      environment as the caller declared it;
//   2. the org's vaulted PRODUCTION credential — Team+;
//   3. the org's vaulted SANDBOX credential — every plan.
//
// Then nothing: reads are still attempted unauthenticated (probes/context.ts),
// and an API that enforces auth answers 401, which is itself an observation.
//
// The environment travels WITH the key from here to every fact, run row and
// score. Before this existed the key was resolved in three places, every one of
// them hardcoded 'production', and a stored sandbox credential was a dead write.

import type { Db } from './db';
import { can } from './plans';
import type { ProbeEnvironment } from './probes/types';
import { resolveProbeCredential, type Actor } from './vaultStore';

export type ProbeAuth =
  | {
      kind: 'byok';
      upstreamKey: string;
      environment: ProbeEnvironment;
      credentialId: null;
      label: null;
      writeConsentAt: null;
      burstConsentAt: null;
    }
  | {
      kind: 'vault';
      upstreamKey: string;
      environment: ProbeEnvironment;
      credentialId: string;
      label: string | null;
      writeConsentAt: Date | null;
      burstConsentAt: Date | null;
    }
  | {
      kind: 'none';
      upstreamKey: undefined;
      environment: 'production';
      credentialId: null;
      label: null;
      writeConsentAt: null;
      burstConsentAt: null;
    };

export type SelectProbeAuthInput = {
  orgId: string;
  apiId: string;
  plan: string;
  actor: Actor;
  byok?: { key: string; environment: ProbeEnvironment } | null;
};

export async function selectProbeAuth(db: Db, input: SelectProbeAuthInput): Promise<ProbeAuth> {
  if (input.byok?.key) {
    return {
      kind: 'byok',
      upstreamKey: input.byok.key,
      environment: input.byok.environment,
      credentialId: null,
      label: null,
      writeConsentAt: null,
      burstConsentAt: null,
    };
  }

  const tryVault = async (environment: ProbeEnvironment): Promise<ProbeAuth | null> => {
    const resolved = await resolveProbeCredential(db, { orgId: input.orgId, apiId: input.apiId, environment, actor: input.actor });
    if (!resolved.ok) return null;
    return {
      kind: 'vault',
      upstreamKey: resolved.secret,
      environment,
      credentialId: resolved.credentialId,
      label: resolved.label,
      writeConsentAt: resolved.writeConsentAt,
      burstConsentAt: resolved.burstConsentAt,
    };
  };

  if (can(input.plan, 'vaultedCredentials')) {
    const production = await tryVault('production');
    if (production) return production;
  }
  if (can(input.plan, 'sandboxProbing')) {
    const sandbox = await tryVault('sandbox');
    if (sandbox) return sandbox;
  }

  return {
    kind: 'none',
    upstreamKey: undefined,
    environment: 'production',
    credentialId: null,
    label: null,
    writeConsentAt: null,
    burstConsentAt: null,
  };
}
