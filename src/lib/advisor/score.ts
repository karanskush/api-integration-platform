// get_score_explanation — why this API scored what it scored.
//
// The distinction this tool has to keep straight is the product's core trust
// claim: a *verified* score comes from live probes and every line of it points
// at a stored evidence fact; a *preview* is static spec analysis and is never
// allowed to read as a verdict (TECH_IMPLEMENTATION.md §7, Phase 2 gate).
// Callers get an explicit `verified` boolean plus the basis, so an agent can
// tell "measured" from "inferred" without parsing prose.

import { scorePreview } from '../scorePreview';
import { asData, type AdvisorContext } from './types';

const BANDS: Array<[number, string]> = [
  [90, 'excellent — an agent can integrate this from the spec with few surprises'],
  [75, 'good — mostly self-describing, with some gaps to work around'],
  [55, 'mixed — expect to debug auth, error handling, or undocumented response shapes'],
  [35, 'weak — significant guesswork required; plan for trial and error'],
  [0, 'poor — the spec alone is not enough to integrate reliably'],
];

function band(total: number): string {
  for (const [floor, label] of BANDS) if (total >= floor) return label;
  return BANDS[BANDS.length - 1][1];
}

const SUBSCORE_MEANING = {
  authClarity: 'Whether auth is discoverable and satisfiable from the spec alone, confirmed against the live API.',
  errorQuality: 'Whether 4xx responses carry a readable, actionable message.',
  docDrift: 'Whether real response shapes match the documented ones, field by field.',
  idempotency: 'Whether writes expose a retry-safety mechanism.',
} as const;

export function getScoreExplanation(ctx: AdvisorContext) {
  const verified = ctx.insights.verified;

  if (verified) {
    const subscores = {
      authClarity: { score: verified.authClarity, outOf: 25, meaning: SUBSCORE_MEANING.authClarity },
      errorQuality:
        verified.errorQuality === null
          ? { score: null, outOf: 25, meaning: SUBSCORE_MEANING.errorQuality, note: 'Not probed — no read-safe operation had enough example data to provoke a gradeable error. Excluded from the total rather than counted as a failure.' }
          : { score: verified.errorQuality, outOf: 25, meaning: SUBSCORE_MEANING.errorQuality },
      docDrift:
        verified.docDrift === null
          ? { score: null, outOf: 25, meaning: SUBSCORE_MEANING.docDrift, note: 'Not probed — the spec documents no response schema to compare a live response against. Excluded from the total.' }
          : { score: verified.docDrift, outOf: 25, meaning: SUBSCORE_MEANING.docDrift },
      idempotency: { score: verified.idempotency, outOf: 25, meaning: SUBSCORE_MEANING.idempotency },
    };

    return {
      total: verified.total,
      outOf: 100,
      verified: true,
      // Version fencing: a stale score is still a verified measurement — of a
      // contract that has since changed. Say both, and never let `verified`
      // alone imply the number describes what the API serves today.
      stale: verified.stale,
      basis: verified.stale
        ? 'live probes against the running API, verified against a PREVIOUS spec version'
        : 'live probes against the running API',
      verifiedAt: verified.verifiedAt,
      specVersionId: verified.specVersionId,
      ...(verified.stale
        ? {
            staleNote:
              'The spec changed after this score was verified. The score describes the previous version until the next verification run; call docentapi_get_changes_since to see what changed.',
          }
        : {}),
      interpretation: band(verified.total),
      scoring:
        'Each sub-score is graded out of 25. Sub-scores that could not be probed are excluded and the total is renormalized over the ones that ran, so an unprobeable check never reads as a failed one.',
      // The sample this number rests on, and how much of it was actually
      // measured. Published rather than blended away because "verified" over a
      // handful of requests is a different claim from "verified" over a
      // thorough one, and an agent is entitled to weigh them differently.
      // A row is only written at all when at least one call succeeded.
      sample:
        verified.liveCallsAttempted === 0
          ? {
              recorded: false,
              note: 'This score predates per-run call accounting, so its sample size is unknown. Treat it as weaker evidence than a score that reports one, and re-verify to replace it.',
            }
          : {
              recorded: true,
              upstreamCallsAttempted: verified.liveCallsAttempted,
              upstreamCallsSucceeded: verified.liveCallsSucceeded,
              observedPoints: verified.observedPoints,
              staticPoints: verified.staticPoints,
              note: 'observedPoints came from what the API actually returned; staticPoints were derived from the spec alone (auth scheme and idempotency parameter names cannot be measured by calling). A score with staticPoints only would not have been written.',
            },
      subscores,
      evidence: verified.explanation.map((e) => ({ factId: e.factId, finding: asData(e.message, 300) })),
      note: 'Every finding above is backed by a stored evidence fact; factId is its durable identifier.',
    };
  }

  // No verification run yet — fall back to the static preview, clearly labelled.
  const preview = scorePreview(ctx.record);
  return {
    total: preview.total,
    outOf: 100,
    verified: false,
    basis: 'static analysis of the spec only — no live request has been made to this API',
    interpretation: band(preview.total),
    scoring: 'Four static checks, 25 points each.',
    checks: preview.checks.map((c) => ({
      id: c.id,
      label: c.label,
      score: c.points,
      outOf: c.maxPoints,
      finding: asData(c.message, 300),
    })),
    note: 'This is a preview, not a verified score. It cannot detect doc drift, error quality, or real auth behaviour, because those require probing the live API. The page owner can trigger a verification run to produce a verified score.',
  };
}
