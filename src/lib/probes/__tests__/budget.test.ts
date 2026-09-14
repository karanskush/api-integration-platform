// The run-level outbound ceiling.
//
// Every cap in the probe engine was a per-module constant, and
// MAX_PROBED_ACTIONS — evidently intended as the run-level budget — was
// referenced by nothing. This is that budget, enforced at the same DI seam
// every probe already calls through so no probe has to remember it.

import { describe, expect, it, vi } from 'vitest';
import { BudgetExhaustedError, EffectBudgetExhaustedError, WriteFenceError, createBudget, createEffectBudget, withBudget, withEffectBudget, withPacing, withWriteFence } from '../budget';
import type { invokeAction } from '../../mcpTools';

const ok = (async () => ({ status: 200, latencyMs: 1, bodyText: '{}' })) as typeof invokeAction;

// invokeAction takes (action, args, target, upstreamKey) — none of which the
// budget inspects, so a minimal stand-in is enough.
const callArgs = [{}, {}, { baseUrls: ['https://x.test'] }, undefined] as unknown as Parameters<
  typeof invokeAction
>;

describe('createBudget', () => {
  it('allows exactly the requested number of calls', () => {
    const budget = createBudget({ maxRequests: 3, deadlineMs: 60_000 });

    expect(budget.spend()).toBe(true);
    expect(budget.spend()).toBe(true);
    expect(budget.spend()).toBe(true);
    expect(budget.spend()).toBe(false);
  });

  it('reports what is left', () => {
    const budget = createBudget({ maxRequests: 2, deadlineMs: 60_000 });
    expect(budget.remaining()).toBe(2);
    budget.spend();
    expect(budget.remaining()).toBe(1);
    budget.spend();
    expect(budget.remaining()).toBe(0);
  });

  it('distinguishes an exhausted budget from an expired deadline', () => {
    const spent = createBudget({ maxRequests: 1, deadlineMs: 60_000 });
    spent.spend();
    expect(spent.reason()).toBe('budget_exhausted');

    // A request count alone does not bound a function with a 60s limit, which
    // is why the deadline sits beside it.
    let clock = 0;
    const timed = createBudget({ maxRequests: 100, deadlineMs: 1_000, now: () => clock });
    expect(timed.spend()).toBe(true);
    clock = 1_500;
    expect(timed.spend()).toBe(false);
    expect(timed.reason()).toBe('deadline_exceeded');
  });

  it('is ok until something actually stops it', () => {
    expect(createBudget({ maxRequests: 1, deadlineMs: 60_000 }).reason()).toBe('ok');
  });
});

describe('withBudget', () => {
  it('passes calls through while the budget allows', async () => {
    const inner = vi.fn(ok);
    const wrapped = withBudget(inner as typeof invokeAction, createBudget({ maxRequests: 2, deadlineMs: 60_000 }));

    await wrapped(...callArgs);
    await wrapped(...callArgs);

    expect(inner).toHaveBeenCalledTimes(2);
  });

  // A synthetic `{ status: 0 }` would be indistinguishable from a real answer
  // to every probe downstream — and this codebase has already been bitten once
  // by a fabricated status reaching users as "returned an unreadable error on a
  // 0 response". A throw is what probes already handle as "nothing to grade".
  it('throws rather than fabricating a response when the budget is spent', async () => {
    const inner = vi.fn(ok);
    const wrapped = withBudget(inner as typeof invokeAction, createBudget({ maxRequests: 1, deadlineMs: 60_000 }));

    await wrapped(...callArgs);
    await expect(wrapped(...callArgs)).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('names why it stopped', async () => {
    const wrapped = withBudget(ok, createBudget({ maxRequests: 0, deadlineMs: 60_000 }));
    await expect(wrapped(...callArgs)).rejects.toMatchObject({ stop: 'budget_exhausted' });
  });

  it('carries no request detail in the error, so nothing can leak through a log', async () => {
    const wrapped = withBudget(ok, createBudget({ maxRequests: 0, deadlineMs: 60_000 }));
    const err = await wrapped(...callArgs).then(
      () => null,
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect(err!.message).toBe('budget_exhausted');
    expect(err!.message).not.toContain('http');
  });

  it('shares one ceiling across every probe that draws on it', async () => {
    const inner = vi.fn(ok);
    const budget = createBudget({ maxRequests: 3, deadlineMs: 60_000 });
    // Two "probes" wrapping the same budget, as reverifyOne will wire them.
    const probeA = withBudget(inner as typeof invokeAction, budget);
    const probeB = withBudget(inner as typeof invokeAction, budget);

    await probeA(...callArgs);
    await probeB(...callArgs);
    await probeA(...callArgs);
    await expect(probeB(...callArgs)).rejects.toBeInstanceOf(BudgetExhaustedError);

    expect(inner).toHaveBeenCalledTimes(3);
  });
});

describe('withWriteFence', () => {
  const okInvoke = (async () => ({ status: 200, latencyMs: 1, bodyText: '{}' })) as typeof invokeAction;
  const act = (method: string, name = 'op') =>
    ({ id: 'x', name, description: '', method, path: '/x', paramsSchema: { type: 'object', properties: {} }, auth: 'none', safety: 'read', examples: [] }) as Parameters<typeof invokeAction>[0];
  const target = { baseUrls: ['https://api.example.com'] };

  it('passes reads through', async () => {
    const fenced = withWriteFence(okInvoke, {});
    await expect(fenced(act('GET'), {}, target, undefined)).resolves.toMatchObject({ status: 200 });
    await expect(fenced(act('HEAD'), {}, target, undefined)).resolves.toMatchObject({ status: 200 });
  });

  it('refuses every mutating method when nothing is authorised', async () => {
    const inner = vi.fn(okInvoke);
    const fenced = withWriteFence(inner as typeof invokeAction, {});
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expect(fenced(act(m), {}, target, undefined)).rejects.toBeInstanceOf(WriteFenceError);
    }
    expect(inner).not.toHaveBeenCalled();
  });

  it('refuses a write on production even when the tool is on the allow-list', async () => {
    const fenced = withWriteFence(okInvoke, { environment: 'production', allow: new Set(['create_thing']) });
    await expect(fenced(act('POST', 'create_thing'), {}, target, undefined)).rejects.toBeInstanceOf(WriteFenceError);
  });

  it('allows exactly the authorised tools on a sandbox', async () => {
    const fenced = withWriteFence(okInvoke, { environment: 'sandbox', allow: new Set(['create_thing']) });
    await expect(fenced(act('POST', 'create_thing'), {}, target, undefined)).resolves.toMatchObject({ status: 200 });
    await expect(fenced(act('POST', 'create_other'), {}, target, undefined)).rejects.toBeInstanceOf(WriteFenceError);
  });

  it('carries no request detail in the error', () => {
    expect(new WriteFenceError().message).toBe('fenced');
  });
});

describe('withPacing', () => {
  it('spaces sequential calls by at least the interval, using the injected clock', async () => {
    let clock = 1_000;
    const slept: number[] = [];
    const inner = (async () => ({ status: 200, latencyMs: 1, bodyText: '{}' })) as typeof invokeAction;
    const paced = withPacing(inner, 250, {
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    const a = { id: 'x', name: 'op', description: '', method: 'GET', path: '/x', paramsSchema: { type: 'object', properties: {} }, auth: 'none', safety: 'read', examples: [] } as Parameters<typeof invokeAction>[0];
    const target = { baseUrls: ['https://api.example.com'] };
    await paced(a, {}, target, undefined); // first call: no wait
    clock += 100; // the call took 100ms
    await paced(a, {}, target, undefined); // 150ms still owed
    expect(slept).toEqual([150]);
  });
});

describe('withEffectBudget', () => {
  const ok = (async () => ({ status: 200, latencyMs: 1, bodyText: '{}' })) as typeof invokeAction;
  const op = (method: string) =>
    ({ id: 'x', name: 'op', description: '', method, path: '/x', paramsSchema: { type: 'object', properties: {} }, auth: 'none', safety: 'write', examples: [] }) as Parameters<typeof invokeAction>[0];
  const target = { baseUrls: ['https://api.example.com'] };

  it('counts only mutating calls', async () => {
    const effects = createEffectBudget(2);
    const wrapped = withEffectBudget(ok, effects);
    await wrapped(op('GET'), {}, target, undefined);
    await wrapped(op('POST'), {}, target, undefined);
    expect(effects.used()).toBe(1);
    expect(effects.remaining()).toBe(1);
  });

  it('refuses the mutation that would exceed the ceiling, before it is sent', async () => {
    let sent = 0;
    const inner = (async () => {
      sent++;
      return { status: 200, latencyMs: 1, bodyText: '{}' };
    }) as typeof invokeAction;
    const wrapped = withEffectBudget(inner, createEffectBudget(1));
    await wrapped(op('POST'), {}, target, undefined);
    await expect(wrapped(op('DELETE'), {}, target, undefined)).rejects.toBeInstanceOf(EffectBudgetExhaustedError);
    expect(sent).toBe(1);
  });

  it('a read still passes once the effect budget is spent', async () => {
    const wrapped = withEffectBudget(ok, createEffectBudget(0));
    await expect(wrapped(op('GET'), {}, target, undefined)).resolves.toMatchObject({ status: 200 });
  });
});
