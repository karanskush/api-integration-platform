// One place that knows how to log a model failure without leaking a credential.
//
// This exists because of a real outage. Every model-backed feature in this
// codebase was failing on the same Azure request-URL bug, and not one of the five
// call sites recorded why:
//
//   ask/route.ts            console.error('[ask] failed', { slug })     — err dropped
//   p/[id]/ask/route.ts     console.error('[ask] anonymous ...', { id }) — err dropped
//   deepEnrich.ts           catch { continue; }                          — err dropped
//   clarify/triage.ts       catch { return degraded }                    — err dropped
//   clarify/synthesize.ts   catch { return degraded }                    — err dropped
//
// So production logged "[ask] failed" and nothing else, and the diagnosis had to
// be reconstructed from a latency figure and a row count. Degrading gracefully is
// correct in all five places; degrading SILENTLY is what cost the time.
//
// APICallError carries the four fields that identify a provider rejection —
// statusCode, url, isRetryable, responseBody — and two that must never be logged:
//
//   responseHeaders    can echo tokens back
//   requestBodyValues  the entire prompt, unbounded, plus any spec text in it
//
// The api-key travels as a request header, so `url` is safe to log; the Azure URL
// test asserts the key never reaches a query string precisely so this stays true.

import { APICallError } from 'ai';

const MAX_RESPONSE_BODY = 500;

export function logModelFailure(scope: string, ctx: Record<string, unknown>, err: unknown): void {
  if (APICallError.isInstance(err)) {
    console.error(`${scope} model call failed`, {
      ...ctx,
      statusCode: err.statusCode,
      url: err.url,
      retryable: err.isRetryable,
      responseBody: err.responseBody?.slice(0, MAX_RESPONSE_BODY),
    });
    return;
  }
  console.error(`${scope} failed`, {
    ...ctx,
    name: err instanceof Error ? err.name : typeof err,
    message: err instanceof Error ? err.message : String(err),
  });
}
