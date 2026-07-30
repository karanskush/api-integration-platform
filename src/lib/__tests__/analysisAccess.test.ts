import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analysisAccessTokenFor, verifyAnalysisAccessToken } from '../analysisAccess';

const ENV = 'DOCENTAPI_MASTER_KEY';
const original = process.env[ENV];

const API_ID = 'api-aaaa';
const OTHER_API_ID = 'api-bbbb';

beforeEach(() => {
  process.env[ENV] = Buffer.alloc(32, 21).toString('base64');
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe('analysisAccessTokenFor / verifyAnalysisAccessToken', () => {
  it('a freshly issued token verifies for its own api', () => {
    const token = analysisAccessTokenFor(API_ID);
    expect(verifyAnalysisAccessToken(token, API_ID)).toBe(true);
  });

  it('is scoped per api — a token for one api never verifies for another', () => {
    const token = analysisAccessTokenFor(API_ID);
    expect(verifyAnalysisAccessToken(token, OTHER_API_ID)).toBe(false);
  });

  it('rejects a missing token', () => {
    expect(verifyAnalysisAccessToken(undefined, API_ID)).toBe(false);
    expect(verifyAnalysisAccessToken(null, API_ID)).toBe(false);
    expect(verifyAnalysisAccessToken('', API_ID)).toBe(false);
  });

  it('rejects a malformed token', () => {
    expect(verifyAnalysisAccessToken('not-a-real-token', API_ID)).toBe(false);
    expect(verifyAnalysisAccessToken('too.many.parts', API_ID)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const token = analysisAccessTokenFor(API_ID);
    const [ts] = token.split('.');
    expect(verifyAnalysisAccessToken(`${ts}.deadbeef`, API_ID)).toBe(false);
  });

  it('rejects an expired token (older than 7 days)', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const token = analysisAccessTokenFor(API_ID, eightDaysAgo);
    expect(verifyAnalysisAccessToken(token, API_ID)).toBe(false);
  });

  it('accepts a token just under the TTL boundary', () => {
    const almostSevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000 - 60_000);
    const token = analysisAccessTokenFor(API_ID, almostSevenDaysAgo);
    expect(verifyAnalysisAccessToken(token, API_ID)).toBe(true);
  });

  it('rejects a timestamp claiming to be from the future', () => {
    const token = analysisAccessTokenFor(API_ID, Date.now() + 60_000);
    expect(verifyAnalysisAccessToken(token, API_ID)).toBe(false);
  });

  it('is deterministic for the same api and timestamp', () => {
    expect(analysisAccessTokenFor(API_ID, 0)).toBe(analysisAccessTokenFor(API_ID, 0));
  });

  it('is distinct from the MCP access token for the same identifier', async () => {
    const { mcpAccessTokenFor } = await import('../mcpAccess');
    const token = analysisAccessTokenFor(API_ID, 0);
    expect(token).not.toBe(mcpAccessTokenFor(API_ID, 0));
  });
});
