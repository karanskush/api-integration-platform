// Org-scoped MCP access tokens — the gate on vaulted credentials.
//
// WHY THIS EXISTS. TECH_IMPLEMENTATION.md §3.5 specifies the auth resolution
// order for executable endpoint tools as: caller-supplied header (BYOK) → org
// vaulted credential (Team+, "if the caller is authorized") → unauthenticated.
// That parenthetical is the entire security problem. /mcp/[id] is a public,
// unauthenticated endpoint by design — anyone can point an agent at a generated
// server. If "org vaulted credential" applied to any caller, then storing a
// credential would publish it: every anonymous request would execute against
// the upstream API using the owner's key, billed to the owner, with the owner's
// privileges. That is strictly worse than not having a vault.
//
// So vaulted credentials require the caller to prove org membership. MCP has no
// OAuth 2.1 flow yet (deferred per ARCHITECTURE_2026-05-20.md), so this is a
// bearer token the owner generates and puts in their own agent config —
// derived, not stored, exactly like CI sync tokens (ciSync.ts): no
// shared-secret column to leak, and rotation is a version bump on
// orgs.mcp_token_version.
//
// Without a valid token, the resolution order collapses to BYOK → unauthenticated,
// which is precisely Phase 1's behaviour. Nothing regresses for anonymous users.

import { deriveKey, hmacHex, secretsEqual } from './keys';

export const MCP_ACCESS_HEADER = 'x-docentapi-access-token';
const TOKEN_PREFIX = 'spck_mcp_';

export function mcpAccessTokenFor(orgId: string, version: number): string {
  const key = deriveKey('mcp-access', `${orgId}:${version}`);
  return `${TOKEN_PREFIX}${key.toString('base64url')}`;
}

// Rejects anything not matching the CURRENT version, so bumping
// orgs.mcp_token_version revokes every token previously issued for the org.
export function verifyMcpAccessToken(
  presented: string | null | undefined,
  orgId: string,
  version: number,
): boolean {
  if (!presented || !presented.startsWith(TOKEN_PREFIX)) return false;
  return secretsEqual(presented, mcpAccessTokenFor(orgId, version));
}

// Attribution for the audit log: stable across calls by the same token, so
// usage can be traced, but not reversible back to the token itself.
export function actorHashForToken(token: string): string {
  return hmacHex(deriveKey('audit-actor'), token).slice(0, 32);
}
