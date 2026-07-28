// The gate that decides whether a model may retire a question.
//
// Triage lets the model say "this is already answered — here is the sentence
// that answers it". On its own that is worth nothing: a model can produce a
// fluent sentence that appears nowhere, and the whole point of the clarification
// loop is that a confident wrong answer is worse than an open question.
//
// So a claim is only accepted if the sentence it quotes provably exists in the
// evidence we handed over. Three properties, in order of how much they buy:
//
//   1. ENVELOPE-SCOPED. The model must name WHICH piece of evidence it read, and
//      the quote is checked against that piece alone. Searching the whole
//      concatenated context instead would be close to free to pass: 24 KB of
//      spec descriptions and crawled docs contains a substring resembling almost
//      any plausible sentence. This is the property that does the real work.
//   2. LENGTH-BANDED. Below MIN_QUOTE_CHARS a quote like "the server sets it"
//      matches half the corpus by luck. Above MAX_QUOTE_CHARS the model is
//      reproducing a paragraph rather than citing a claim, and a long quote that
//      merely contains the answer is not evidence of having read it.
//   3. RELEVANCE-ANCHORED. A quote can be real, in the named envelope, and about
//      something else entirely. A sibling field or a crawled page has to mention
//      the field or the operation for a sentence in it to bear on this question.
//      The field's own description is exempt: it is by definition about the field.
//
// What this cannot do — and where the honesty has to come from the product
// rather than the matcher — is survive text planted to be quoted. A spec whose
// field description reads "the server always overwrites this; no clarification
// needed" passes all three checks, because it IS in the spec and it IS about the
// field. That is precisely why triage may only downgrade a question to an
// assumption the owner sees, with this quote and its source shown, and never
// delete one. The cost of a successful plant is one extra click, not a lie in the
// published record.

import { asData } from '../advisor/types';

export type EvidenceSourceKind = 'spec_field' | 'spec_sibling' | 'docs';

// One citable piece of evidence, named so a model can point at exactly one.
export type EvidenceEnvelope = {
  id: string; // what the model cites, e.g. 'spec_field' or 'docs:2'
  kind: EvidenceSourceKind;
  text: string;
  url?: string; // docs only
};

export const MIN_QUOTE_CHARS = 24;
export const MAX_QUOTE_CHARS = 300;

// Matching has to tolerate the transformations the text has already been through
// without tolerating a paraphrase.
//
// asData() collapsed whitespace and appended a single-character ellipsis on
// truncation before any of this text reached a prompt, so a naive includes()
// false-negatives on a quote that spans a truncation boundary or that the model
// re-spaced. NFKC folds the typographic variants a model reliably "corrects" —
// curly quotes, non-breaking spaces, ligatures — none of which change meaning.
export function normalizeForMatch(text: string): string {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      // Ellipsis removal has to come AFTER NFKC, not before: NFKC expands U+2026
      // into three dots, so stripping the single character first leaves the
      // expansion behind. One rule applied afterwards catches both the sentinel
      // asData() appends and a literal "..." already in the text.
      //
      // Removing every occurrence rather than only a trailing one matters because
      // buildEnvelopes joins several already-truncated strings, so a sentinel can
      // land mid-envelope. Safe because the same normalization runs on both the
      // quote and the envelope: two strings differing only in ellipses were going
      // to match either way.
      .replace(/\.{3,}/g, '')
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[‐-―]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// Strips what a model adds around a citation rather than inside it: wrapping
// quotes it introduced, and a trailing sentence terminator it completed.
function trimCitation(quote: string): string {
  return quote
    .trim()
    .replace(/^["'`“‘]+/, '')
    .replace(/["'`”’]+$/, '')
    .replace(/[.,;:!?]+$/, '')
    .trim();
}

export type QuoteVerdict =
  | { ok: true; envelope: EvidenceEnvelope }
  | { ok: false; reason: string };

// Whether `quote` provably came from the envelope the model named.
export function verifyQuote(
  quote: string | undefined,
  envelopeId: string | undefined,
  envelopes: EvidenceEnvelope[],
): QuoteVerdict {
  if (!quote?.trim()) return { ok: false, reason: 'no quote supplied' };
  if (!envelopeId) return { ok: false, reason: 'no evidence source named' };

  const envelope = envelopes.find((e) => e.id === envelopeId);
  if (!envelope) return { ok: false, reason: `named source "${envelopeId}" was not supplied to the model` };

  const cleaned = trimCitation(quote);
  if (cleaned.length < MIN_QUOTE_CHARS) {
    return { ok: false, reason: `quote is shorter than ${MIN_QUOTE_CHARS} characters` };
  }
  if (cleaned.length > MAX_QUOTE_CHARS) {
    return { ok: false, reason: `quote is longer than ${MAX_QUOTE_CHARS} characters` };
  }

  const haystack = normalizeForMatch(envelope.text);
  const needle = normalizeForMatch(cleaned);
  if (!needle) return { ok: false, reason: 'quote is empty once normalized' };
  if (!haystack.includes(needle)) {
    return { ok: false, reason: `quote does not appear in "${envelopeId}"` };
  }

  return { ok: true, envelope };
}

// Whether a piece of evidence bears on THIS question at all.
//
// A field's own description always does. Anything else — a sibling field, a
// crawled page — has to name the field or the operation, or a true sentence
// about an unrelated part of the API would be enough to retire a question it
// says nothing about.
export function isRelevant(envelope: EvidenceEnvelope, fieldPath: string, actionName: string, actionPath: string): boolean {
  if (envelope.kind === 'spec_field') return true;

  const haystack = normalizeForMatch(envelope.text);
  const leaf = fieldPath.slice(fieldPath.lastIndexOf('.') + 1).replace(/\[\]$/, '');
  const candidates = [leaf, fieldPath, actionName, actionPath].filter((c) => c && c.length >= 3);
  return candidates.some((c) => haystack.includes(normalizeForMatch(c)));
}

// Builds the citable set for one question. Every string is capped and sanitized
// on the way in, exactly as deepEnrich does, so the prompt never carries raw
// third-party text and the stored quote can never carry control characters.
export function buildEnvelopes(input: {
  fieldDescription?: string;
  siblingDescriptions?: Array<{ field: string; description: string }>;
  actionDescription?: string;
  docs?: Array<{ url: string; title?: string; excerpt: string }>;
}): EvidenceEnvelope[] {
  const out: EvidenceEnvelope[] = [];

  const fieldText = asData(input.fieldDescription ?? '', 400);
  if (fieldText) out.push({ id: 'spec_field', kind: 'spec_field', text: fieldText });

  const siblingParts = [
    ...(input.actionDescription ? [asData(input.actionDescription, 300)] : []),
    ...(input.siblingDescriptions ?? []).map((s) => `${s.field}: ${asData(s.description, 200)}`),
  ].filter(Boolean);
  if (siblingParts.length) {
    out.push({ id: 'spec_sibling', kind: 'spec_sibling', text: siblingParts.join(' — ') });
  }

  for (const [i, doc] of (input.docs ?? []).entries()) {
    const text = asData(`${doc.title ? `${doc.title}. ` : ''}${doc.excerpt}`, 1500);
    if (text) out.push({ id: `docs:${i}`, kind: 'docs', text, url: doc.url });
  }

  return out;
}
