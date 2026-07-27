// The clarification email's magic link: lets someone finish setting up an
// API from a device with no Clerk session (the whole point of emailing a
// link) without a separate token-storage table. The timestamp is embedded in
// the token itself rather than looked up, so verification needs no DB round
// trip and no side channel can extend a token past its TTL by touching a row.
//
// This is deliberately weaker than mcpAccess.ts's org token (time-boxed,
// not instantly revocable by a version bump) because the blast radius is
// different: it grants "answer a few open questions about one API," not
// "spend a vaulted credential." The completion route still requires this
// token AND (once the click lands on a browser with a session) confirms the
// signed-in user is actually a member of the API's org before writing
// anything — this token alone is not the full authorization story.

import { deriveKey, hmacHex, verifyHmacHex } from './keys';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — long enough for someone to get back to their inbox

export function analysisAccessTokenFor(apiId: string, issuedAt: number = Date.now()): string {
  const key = deriveKey('analysis-access', apiId);
  const ts = issuedAt.toString(36);
  const sig = hmacHex(key, `${apiId}:${ts}`);
  return `${ts}.${sig}`;
}

export function verifyAnalysisAccessToken(token: string | null | undefined, apiId: string): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [ts, sig] = parts;
  const issuedAt = parseInt(ts, 36);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false;
  const age = Date.now() - issuedAt;
  if (age < 0 || age > TOKEN_TTL_MS) return false;

  const key = deriveKey('analysis-access', apiId);
  return verifyHmacHex(key, `${apiId}:${ts}`, sig);
}
