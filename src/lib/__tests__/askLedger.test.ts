import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASK_OUTCOME_UNSETTLED, askCredits, askLedgerRow } from '../askLedger';

const base = { apiId: 'api_1', orgId: 'org_1', startedAt: 1_000 };
const NOW = 3_500;

const originalCredits = process.env.ASK_CREDITS_PER_TURN;
const originalMaster = process.env.DOCENTAPI_MASTER_KEY;

beforeEach(() => {
  delete process.env.ASK_CREDITS_PER_TURN;
});

afterEach(() => {
  if (originalCredits === undefined) delete process.env.ASK_CREDITS_PER_TURN;
  else process.env.ASK_CREDITS_PER_TURN = originalCredits;
  if (originalMaster === undefined) delete process.env.DOCENTAPI_MASTER_KEY;
  else process.env.DOCENTAPI_MASTER_KEY = originalMaster;
});

describe('askLedgerRow', () => {
  it('bills a completed turn as 200', () => {
    expect(askLedgerRow({ status: 'ok', steps: 3, toolCalls: 2 }, base, NOW)).toMatchObject({
      status: '200',
      credits: 5,
      latencyMs: 2_500,
      tool: 'ask',
    });
  });

  it('does not bill a failed turn', () => {
    expect(askLedgerRow({ status: 'error', error: new Error('boom') }, base, NOW)).toMatchObject({
      status: '502',
      credits: 0,
    });
  });

  // The reader stopped reading; the tokens were still generated and paid for.
  it('bills an aborted turn and buckets it as 4xx', () => {
    expect(askLedgerRow({ status: 'aborted', steps: 1 }, base, NOW)).toMatchObject({
      status: '499',
      credits: 5,
    });
  });

  // A hang recorded as a success would be invisible in the failure-rate panel,
  // which is the one place it needs to show up.
  it('records an unsettled outcome as 5xx rather than a billed success', () => {
    expect(askLedgerRow(ASK_OUTCOME_UNSETTLED, base, NOW)).toMatchObject({
      status: '504',
      credits: 5,
    });
  });

  it('carries callerHash through, and defaults it to null', () => {
    expect(askLedgerRow({ status: 'ok', steps: 1, toolCalls: 0 }, base, NOW).callerHash).toBeNull();
    expect(
      askLedgerRow({ status: 'ok', steps: 1, toolCalls: 0 }, { ...base, callerHash: 'abc' }, NOW)
        .callerHash,
    ).toBe('abc');
  });

  it('never emits a negative latency if the clock moves backwards', () => {
    expect(askLedgerRow({ status: 'ok', steps: 1, toolCalls: 0 }, base, 0).latencyMs).toBe(0);
  });
});

describe('askCredits', () => {
  it('defaults to 5 per turn', () => {
    expect(askCredits()).toBe(5);
  });

  it('is env-overridable', () => {
    process.env.ASK_CREDITS_PER_TURN = '2';
    expect(askCredits()).toBe(2);
  });

  it('ignores a nonsense override rather than billing NaN', () => {
    process.env.ASK_CREDITS_PER_TURN = 'free';
    expect(askCredits()).toBe(5);
  });
});
