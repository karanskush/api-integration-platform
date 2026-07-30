import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorHashForToken, MCP_ACCESS_HEADER, mcpAccessTokenFor, verifyMcpAccessToken } from '../mcpAccess';

const ENV = 'DOCENTAPI_MASTER_KEY';
const original = process.env[ENV];

const ORG = 'org-aaaa';
const OTHER_ORG = 'org-bbbb';

beforeEach(() => {
  process.env[ENV] = Buffer.alloc(32, 21).toString('base64');
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe('mcpAccessTokenFor', () => {
  it('is deterministic, so the owner can re-read it without rotating', () => {
    expect(mcpAccessTokenFor(ORG, 0)).toBe(mcpAccessTokenFor(ORG, 0));
  });

  it('is scoped per org', () => {
    expect(mcpAccessTokenFor(ORG, 0)).not.toBe(mcpAccessTokenFor(OTHER_ORG, 0));
  });

  it('changes when the version is bumped', () => {
    expect(mcpAccessTokenFor(ORG, 0)).not.toBe(mcpAccessTokenFor(ORG, 1));
  });

  it('carries a recognisable prefix and url-safe body', () => {
    expect(mcpAccessTokenFor(ORG, 0)).toMatch(/^spck_mcp_[A-Za-z0-9_-]+$/);
  });

  it('is distinct from the CI token for the same identifier', async () => {
    const { ciTokenFor } = await import('../ciSync');
    expect(mcpAccessTokenFor(ORG, 0)).not.toBe(ciTokenFor(ORG, 0));
  });
});

describe('verifyMcpAccessToken', () => {
  it('accepts the current token', () => {
    expect(verifyMcpAccessToken(mcpAccessTokenFor(ORG, 3), ORG, 3)).toBe(true);
  });

  // The revocation mechanism.
  it('rejects a token from a superseded version', () => {
    expect(verifyMcpAccessToken(mcpAccessTokenFor(ORG, 3), ORG, 4)).toBe(false);
  });

  it('rejects another org’s token', () => {
    expect(verifyMcpAccessToken(mcpAccessTokenFor(OTHER_ORG, 0), ORG, 0)).toBe(false);
  });

  it('rejects absent, empty, and unprefixed values', () => {
    expect(verifyMcpAccessToken(null, ORG, 0)).toBe(false);
    expect(verifyMcpAccessToken(undefined, ORG, 0)).toBe(false);
    expect(verifyMcpAccessToken('', ORG, 0)).toBe(false);
    const valid = mcpAccessTokenFor(ORG, 0);
    expect(verifyMcpAccessToken(valid.replace('spck_mcp_', ''), ORG, 0)).toBe(false);
  });

  it('rejects a truncated or extended token', () => {
    const valid = mcpAccessTokenFor(ORG, 0);
    expect(verifyMcpAccessToken(valid.slice(0, -1), ORG, 0)).toBe(false);
    expect(verifyMcpAccessToken(`${valid}x`, ORG, 0)).toBe(false);
  });

  it('rejects a token whose body was tampered with', () => {
    const valid = mcpAccessTokenFor(ORG, 0);
    const tampered = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A');
    expect(verifyMcpAccessToken(tampered, ORG, 0)).toBe(false);
  });

  it('rejects every token after the master key rotates', () => {
    const token = mcpAccessTokenFor(ORG, 0);
    process.env[ENV] = Buffer.alloc(32, 22).toString('base64');
    expect(verifyMcpAccessToken(token, ORG, 0)).toBe(false);
  });

  it('names the header it is read from', () => {
    expect(MCP_ACCESS_HEADER).toBe('x-docentapi-access-token');
  });
});

describe('actorHashForToken', () => {
  it('is stable for the same token, so usage is traceable', () => {
    const token = mcpAccessTokenFor(ORG, 0);
    expect(actorHashForToken(token)).toBe(actorHashForToken(token));
  });

  it('differs between tokens', () => {
    expect(actorHashForToken(mcpAccessTokenFor(ORG, 0))).not.toBe(actorHashForToken(mcpAccessTokenFor(ORG, 1)));
  });

  it('does not contain the token it identifies', () => {
    const token = mcpAccessTokenFor(ORG, 0);
    const hash = actorHashForToken(token);
    expect(token).not.toContain(hash);
    expect(hash).not.toContain(token.replace('spck_mcp_', '').slice(0, 8));
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});
