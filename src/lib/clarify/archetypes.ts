// What shape of question to ask, and what the answer space is.
//
// The premise: a clarification is only "hard to answer" when we hand someone a
// blank box. Almost every question we raise has an answer space that is fully
// enumerable from the field's own shape plus what lineage already found — no
// model needed to work out what the choices are.
//
// The vocabulary is not invented here. fieldMap.ts's FieldOrigin
// (server_generated | constant | enum_constrained | produced_by_api |
// caller_supplied) IS the universal answer space: every archetype below is a
// specialised, plainer-English wording of "which of these is it?", and every
// closed option carries the FieldOrigin it resolves to. That is what lets an
// answer flow straight into x-spotcheck-origin instead of being collected and
// discarded, and it is why there is no free-text fallback — the fallback is the
// origin picker itself.
//
// Pure and synchronous like fieldMap.ts and lineage.ts: no I/O, so it serves
// ephemeral imports and persisted ones identically. Nothing here consults a
// model, and nothing a model returns may set an archetype — the archetype
// decides what gets written to the published artifact.

import type { FieldNode, FieldOrigin } from '../fieldMap';
import type { Action } from '../ir';
import type { LineageEdge } from '../lineage';
import { isIdLike, pathResources, resourceFromFieldName, tokenize } from '../resource';
import type { OpenQuestionKind } from '../deepEnrich';

export type Archetype =
  | 'identifier_ownership'
  | 'producer_disambiguation'
  | 'description_contradicts_operation'
  | 'optionality_in_practice'
  | 'format_or_shape'
  | 'scope_of_effect'
  | 'undocumented_code_semantics'
  | 'origin_unknown';

// Where an option's text came from. `heuristic` is minted only here, from
// structural facts; `spec` and `docs` must be checkable against the source; a
// model may only ever claim `model_guess`.
export type OptionProvenance = 'spec' | 'docs' | 'heuristic' | 'model_guess';

export type AnswerOption = {
  value: string; // stable identifier, stored in the answer
  label: string; // what the owner reads
  detail?: string; // one clarifying line
  // What choosing this means for x-spotcheck-origin. Absent when the answer
  // refines something other than the field's origin.
  resolvedOrigin?: FieldOrigin;
  provenance: OptionProvenance;
};

export type AnswerSpec = {
  // single_choice: pick one. open_values: enumerate value -> meaning pairs.
  // free_text: genuinely open prose, the case we try hardest to avoid.
  kind: 'single_choice' | 'open_values' | 'free_text';
  options: AnswerOption[];
  // Every closed space keeps an escape hatch. A quiz that forces a wrong answer
  // is worse than a text box, because the wrong answer gets published as fact.
  allowOther: boolean;
};

export type Classification = {
  archetype: Archetype;
  answerSpec: AnswerSpec;
  why: string; // why we are asking
  unlocks: string; // what answering improves
  rank: number; // display order; closed spaces first, open ones last
};

// Ranks drive question order. Easy, concrete questions first is most of the
// perceived-ease win: someone who answers three quickly keeps going.
const RANKS: Record<Archetype, number> = {
  identifier_ownership: 1,
  producer_disambiguation: 2,
  description_contradicts_operation: 3,
  scope_of_effect: 4,
  format_or_shape: 5,
  optionality_in_practice: 6,
  undocumented_code_semantics: 7,
  origin_unknown: 8,
};

const heuristic = (o: Omit<AnswerOption, 'provenance'>): AnswerOption => ({ ...o, provenance: 'heuristic' });

// A POST straight onto a collection — no trailing {param} — is a create. That
// is the only place "who assigns the id?" is a real question: on an update the
// id addresses something that already exists.
function isCreateAction(action: Action): boolean {
  if (action.method !== 'POST') return false;
  return !/\}\s*$/.test(action.path);
}

// Whether an id-shaped field identifies the thing this operation CREATES, as
// opposed to some other entity it merely references.
//
// "Does the server assign this?" is a sensible question about add_pet.body.id
// and a nonsensical one about create_order.body.customerId — the customer
// already exists, and the answer is obviously "you look it up". A bare `id`
// names no other entity and so belongs to the created thing; a foreign-key name
// belongs to the created thing only when it names that same resource.
function identifiesCreatedEntity(action: Action, field: FieldNode): boolean {
  const named = resourceFromFieldName(field.name);
  if (named === null) return true; // `id`, `uuid`, `key` — the record's own
  const resources = pathResources(action.path);
  return resources.includes(named);
}

// Verbs that imply a lifecycle the operation may not actually have. Petstore's
// PUT /user/{username} describes its own path parameter as "name that need to be
// deleted" — a copy-paste from delete_user that has been in the spec for years.
const VERB_SAFETY: Array<{ re: RegExp; implies: Action['safety'] }> = [
  { re: /\b(delete[ds]?|remove[ds]?|destroy(?:ed|s)?|purge[ds]?)\b/i, implies: 'destructive' },
  { re: /\b(create[ds]?|add(?:ed|s)?|register(?:ed|s)?)\b/i, implies: 'write' },
];

function contradictingVerb(text: string | undefined, safety: Action['safety']): string | null {
  if (!text) return null;
  for (const { re, implies } of VERB_SAFETY) {
    const match = re.exec(text);
    if (match && implies !== safety) return match[0];
  }
  return null;
}

// Name matching is tokenized, never regex-on-the-raw-string. resource.ts's
// isIdLike carries the scar: an anchored /(^|_)id$/ recognises `customer_id` and
// silently misses `customerId`, so a camelCase API matches nothing at all.
function lastToken(name: string): string {
  const tokens = tokenize(name);
  return tokens[tokens.length - 1] ?? '';
}

// Names whose values are conventionally a standardised format that the spec
// declares no `format` for — the gap that makes a caller guess.
const STRUCTURED_TOKENS = new Set([
  'date', 'time', 'at', 'timestamp', 'email', 'url', 'uri', 'phone', 'msisdn',
  'currency', 'country', 'locale', 'language', 'timezone', 'tz', 'ip', 'postal', 'zip',
]);

const FORMAT_OPTIONS: AnswerOption[] = [
  heuristic({ value: 'iso8601_datetime', label: 'ISO 8601 / RFC 3339 timestamp', detail: '2026-07-28T14:32:07Z' }),
  heuristic({ value: 'iso8601_date', label: 'ISO 8601 date only', detail: '2026-07-28' }),
  heuristic({ value: 'unix_seconds', label: 'Unix epoch seconds', detail: '1785312000' }),
  heuristic({ value: 'e164', label: 'E.164 phone number', detail: '+14155552671' }),
  heuristic({ value: 'iso4217', label: 'ISO 4217 currency code', detail: 'USD' }),
  heuristic({ value: 'iso3166_alpha2', label: 'ISO 3166-1 alpha-2 country code', detail: 'GB' }),
  heuristic({ value: 'iana_tz', label: 'IANA timezone name', detail: 'Europe/London' }),
];

// Names that read as a code with a closed meaning the spec never wrote down.
const CODE_TOKENS = new Set(['status', 'state', 'code', 'type', 'kind', 'level', 'flag', 'tier', 'category', 'reason']);

// A description that only restates the field name tells a caller nothing.
// "userStatus" described as "User Status" is the Petstore case.
function describesNothing(field: FieldNode): boolean {
  if (!field.description) return true;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(field.description) === norm(field.name);
}

const ORIGIN_OPTIONS: AnswerOption[] = [
  heuristic({
    value: 'caller_supplied',
    label: 'The caller invents it',
    detail: 'Nothing in the API produces this — a person or an integration decides the value.',
    resolvedOrigin: 'caller_supplied',
  }),
  heuristic({
    value: 'produced_by_api',
    label: 'It comes from an earlier call',
    detail: "You read it out of another operation's response first.",
    resolvedOrigin: 'produced_by_api',
  }),
  heuristic({
    value: 'server_generated',
    label: 'The server generates it',
    detail: 'Callers should not send this at all.',
    resolvedOrigin: 'server_generated',
  }),
  heuristic({
    value: 'enum_constrained',
    label: 'It is one of a fixed set of values',
    detail: 'There is a closed list, even though the spec does not declare it.',
    resolvedOrigin: 'enum_constrained',
  }),
  heuristic({
    value: 'constant',
    label: 'It is always the same value',
    resolvedOrigin: 'constant',
  }),
];

// Order is deliberate: the more specific a detector, the earlier it runs, and
// the first match wins. `hint` is the model's own guess at the question kind and
// is used only as a tie-break — it can never select an archetype outright.
export function classify(
  action: Action,
  field: FieldNode,
  producers: LineageEdge[],
  hint?: OpenQuestionKind,
): Classification {
  const finish = (archetype: Archetype, answerSpec: AnswerSpec, why: string, unlocks: string): Classification => ({
    archetype,
    answerSpec,
    why,
    unlocks,
    rank: RANKS[archetype],
  });

  // 1. Who owns the identifier on a create? The one question the spec
  //    structurally cannot answer: Pet.id is writable on POST /pet, and nothing
  //    says whether the server honours or overwrites what you send.
  if (
    isIdLike(field.name) &&
    !field.readOnly &&
    isCreateAction(action) &&
    identifiesCreatedEntity(action, field) &&
    !producers.some((p) => p.confidence === 'high')
  ) {
    return finish(
      'identifier_ownership',
      {
        kind: 'single_choice',
        allowOther: true,
        options: [
          heuristic({
            value: 'server_assigns',
            label: 'The server assigns it and ignores what I send',
            resolvedOrigin: 'server_generated',
          }),
          heuristic({
            value: 'caller_assigns',
            label: 'The caller chooses it',
            detail: 'A client-assigned id the server stores as given.',
            resolvedOrigin: 'caller_supplied',
          }),
          heuristic({
            value: 'either',
            label: 'Either — the server assigns one if I leave it out',
            resolvedOrigin: 'caller_supplied',
          }),
        ],
      },
      `${action.name} creates a record, and "${field.path}" is writable, so a caller cannot tell whether sending an id does anything.`,
      'Agents stop inventing ids on create, or stop omitting one you actually require.',
    );
  }

  // 2. Lineage found candidates but cannot choose between them. The options are
  //    the candidates themselves — nothing is invented.
  const ambiguousProducers = producers.length >= 2 || (producers.length === 1 && producers[0].confidence !== 'high');
  if (ambiguousProducers && producers.length > 0) {
    return finish(
      'producer_disambiguation',
      {
        kind: 'single_choice',
        allowOther: true,
        options: [
          ...producers.slice(0, 5).map((p) =>
            heuristic({
              value: `${p.from.tool}.${p.from.field}`,
              label: `${p.from.tool} → ${p.from.field}`,
              detail: p.why.join(', '),
              resolvedOrigin: 'produced_by_api',
            }),
          ),
          heuristic({
            value: 'none_of_these',
            label: 'None of these — the caller supplies it',
            resolvedOrigin: 'caller_supplied',
          }),
        ],
      },
      `We found more than one plausible source for "${field.path}" and cannot tell which one a caller should actually use.`,
      'Agents get sent to the right operation first instead of guessing between several.',
    );
  }

  // 3. The description describes a different operation than the one it is on.
  const verb = contradictingVerb(field.description, action.safety);
  if (verb) {
    return finish(
      'description_contradicts_operation',
      {
        kind: 'single_choice',
        allowOther: true,
        options: [
          heuristic({ value: 'stale_description', label: 'The description is stale — ignore it' }),
          heuristic({ value: 'description_correct', label: 'The description is right, and this operation really does that' }),
        ],
      },
      `The description of "${field.path}" says "${verb}", but ${action.name} is a ${action.safety} operation.`,
      'Agents stop treating this operation as more (or less) dangerous than it is.',
    );
  }

  // 4. PUT on an item route: does the body replace the record or merge into it?
  if (hint === 'unclear_scope' || (action.method === 'PUT' && field.location === 'body' && /\}\s*$/.test(action.path))) {
    return finish(
      'scope_of_effect',
      {
        kind: 'single_choice',
        allowOther: true,
        options: [
          heuristic({ value: 'full_replace', label: 'Full replace — omitted fields are cleared' }),
          heuristic({ value: 'merge', label: 'Merge — omitted fields are left alone' }),
        ],
      },
      `${action.name} accepts a body on an existing record, and the spec does not say whether leaving a field out clears it.`,
      'Agents stop silently wiping fields they did not mean to touch.',
    );
  }

  // 5. A bare string whose name promises a standardised format the spec omits.
  if (
    field.type === 'string' &&
    !field.format &&
    !field.pattern &&
    !field.enum?.length &&
    field.example === undefined &&
    STRUCTURED_TOKENS.has(lastToken(field.name))
  ) {
    return finish(
      'format_or_shape',
      { kind: 'single_choice', allowOther: true, options: FORMAT_OPTIONS },
      `"${field.path}" is declared only as a string, so a caller has to guess how to format it.`,
      'Generated examples and contract tests use a value the API will actually accept.',
    );
  }

  // 6. A code whose values are never written down. The one genuinely open space
  //    — the meanings cannot be derived from anything we hold.
  //    Requires BOTH signals: a code-shaped name and a description that adds
  //    nothing. A `status` field with a real description is already explained.
  const codeShaped = field.type === 'integer' || field.type === 'number' || field.type === 'string';
  if (codeShaped && !field.enum?.length && CODE_TOKENS.has(lastToken(field.name)) && describesNothing(field)) {
    return finish(
      'undocumented_code_semantics',
      { kind: 'open_values', allowOther: true, options: [] },
      `"${field.path}" looks like a code with a fixed set of meanings, but the spec lists none.`,
      'Agents can read the value back as a state instead of an opaque number.',
    );
  }

  // 7. Optional, on a write, with nothing to suggest what happens if omitted.
  if (
    !field.required &&
    action.safety !== 'read' &&
    field.default === undefined &&
    field.example === undefined &&
    !field.enum?.length
  ) {
    return finish(
      'optionality_in_practice',
      {
        kind: 'single_choice',
        allowOther: true,
        options: [
          heuristic({ value: 'required_in_practice', label: 'Required in practice — the call fails without it' }),
          heuristic({ value: 'optional_with_default', label: 'Genuinely optional — the server picks a default' }),
          heuristic({ value: 'ignored', label: 'Ignored — legacy, accepted but unused' }),
        ],
      },
      `"${field.path}" is optional, but nothing says what happens when a caller leaves it out.`,
      'Agents stop sending filler values for fields that are fine to omit.',
    );
  }

  // 8. Fallback. Deliberately still a closed choice: the five origins are the
  //    complete space, so even "we have no idea" is one tap rather than an essay.
  return finish(
    'origin_unknown',
    { kind: 'single_choice', allowOther: true, options: ORIGIN_OPTIONS },
    `Nothing in the spec or the provider's docs tells us where "${field.path}" is meant to come from.`,
    'Agents know whether to look this value up, invent it, or leave it out entirely.',
  );
}

// The origin a given answer resolves to, if any. Used by the artifact builder to
// let a human answer override the heuristic classification.
export function originForAnswer(spec: AnswerSpec, value: string): FieldOrigin | null {
  return spec.options.find((o) => o.value === value)?.resolvedOrigin ?? null;
}
