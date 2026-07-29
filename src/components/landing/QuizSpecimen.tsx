// One clarification card, rendered from the real classifier.
//
// The specimen is not hand-written copy. It builds the Petstore case that
// motivated the whole clarification loop — Pet.id is writable on POST /pet and
// nothing in the document says whether the server honours or overwrites what
// you send — and passes it through classify() to get the archetype, the
// question, and the answer space that a real owner would actually be shown.
//
// That means this card cannot drift from the engine: change the answer space
// and the landing page changes with it, or the build breaks. It is the same
// discipline the product sells, applied to its own marketing.

import { classify } from '@/lib/clarify';
import type { FieldNode } from '@/lib/fieldMap';
import type { Action } from '@/lib/ir';

const ACTION: Action = {
  id: 'a1b2c3d4',
  name: 'add_pet',
  description: 'Add a new pet to the store.',
  method: 'POST',
  path: '/pet',
  paramsSchema: { type: 'object', properties: {} },
  auth: 'none',
  safety: 'write',
  examples: [],
};

const FIELD: FieldNode = {
  path: 'body.id',
  name: 'id',
  location: 'body',
  type: 'integer',
  format: 'int64',
  required: false,
  nullable: false,
};

export default function QuizSpecimen() {
  // No producers: nothing in the Petstore document yields a pet id before the
  // pet exists, which is precisely why this has to be asked rather than solved.
  const classification = classify(ACTION, FIELD, []);
  const { archetype, answerSpec, why, unlocks } = classification;

  return (
    <figure className="quiz-specimen">
      <div className="qs-card">
        <div className="qs-head">
          <span className="qs-arch">{archetype.replace(/_/g, ' ')}</span>
          <span className="qs-count">Question 1 of 13</span>
        </div>

        <p className="qs-q">Who assigns this id?</p>
        <code className="qs-field">
          {ACTION.name} · {FIELD.path}
        </code>
        <p className="qs-why">{why}</p>

        <ul className="qs-options">
          {answerSpec.options.map((option, i) => (
            <li key={option.value}>
              <span className="qs-key" aria-hidden="true">
                {i + 1}
              </span>
              <span className="qs-label">
                {option.label}
                {option.detail ? <em>{option.detail}</em> : null}
              </span>
            </li>
          ))}
          {answerSpec.allowOther ? (
            <li className="qs-other">
              <span className="qs-key" aria-hidden="true">{answerSpec.options.length + 1}</span>
              <span className="qs-label">Something else…</span>
            </li>
          ) : null}
        </ul>

        <p className="qs-unlocks">
          <span>Unlocks</span> {unlocks}
        </p>
      </div>

      {/* The inverse of the usual disclaimer: this one exists to say the card
          is *not* marketing copy. Same obligation either way — state what the
          reader is looking at. */}
      <figcaption className="disclaimer">
        Rendered by the live classifier, not written for this page.
      </figcaption>
    </figure>
  );
}
